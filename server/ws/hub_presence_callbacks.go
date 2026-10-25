package ws

import (
	"sync"
	"time"
)

const (
	presenceCallbackWorkers = 8
	presenceCallbackQueue   = 256
	presenceCallbackIdle    = time.Second
)

// presenceCallbackTicket reserves same-user order while Hub.mu is held. Its
// callback is submitted after Hub.mu is released. Predecessor channels avoid
// retaining the history of completed tickets.
type presenceCallbackTicket struct {
	userID        string
	name          string
	prevDone      <-chan struct{}
	prevSubmitted <-chan struct{}
	fn            func()
	done          chan struct{}
	submitted     chan struct{}
	once          sync.Once
	submittedOnce sync.Once
}

func (t *presenceCallbackTicket) finish() {
	if t != nil {
		t.markSubmitted()
		t.once.Do(func() { close(t.done) })
	}
}

func (t *presenceCallbackTicket) markSubmitted() {
	if t != nil {
		t.submittedOnce.Do(func() { close(t.submitted) })
	}
}

// presenceCallbackDispatcher stores at most 256 pending callbacks. Workers
// select runnable tickets rather than waiting on predecessor callbacks, so a
// burst for one slow user cannot occupy the pool and starve other users.
type presenceCallbackDispatcher struct {
	mu             sync.Mutex
	pending        []*presenceCallbackTicket
	tails          map[string]*presenceCallbackTicket
	outstanding    map[*presenceCallbackTicket]struct{}
	workers        int
	active         int
	stopping       bool
	shutdownDone   chan struct{}
	wakeWorkers    chan struct{}
	spaceAvailable chan struct{}
	stopSubmit     chan struct{}
	submitWG       sync.WaitGroup
	workerWG       sync.WaitGroup
}

func newPresenceCallbackDispatcher() *presenceCallbackDispatcher {
	return &presenceCallbackDispatcher{
		tails:          make(map[string]*presenceCallbackTicket),
		outstanding:    make(map[*presenceCallbackTicket]struct{}),
		shutdownDone:   make(chan struct{}),
		wakeWorkers:    make(chan struct{}),
		spaceAvailable: make(chan struct{}),
		stopSubmit:     make(chan struct{}),
	}
}

// reserve must be called with Hub.mu held. It establishes callback order at
// the same serialization point as the corresponding connection-state change.
func (d *presenceCallbackDispatcher) reserve(userID, name string) *presenceCallbackTicket {
	if d == nil {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stopping {
		return nil
	}
	ticket := &presenceCallbackTicket{userID: userID, name: name, done: make(chan struct{}), submitted: make(chan struct{})}
	if previous := d.tails[userID]; previous != nil {
		ticket.prevDone = previous.done
		ticket.prevSubmitted = previous.submitted
	}
	d.tails[userID] = ticket
	d.outstanding[ticket] = struct{}{}
	return ticket
}

func (d *presenceCallbackDispatcher) submit(ticket *presenceCallbackTicket, callback func()) {
	if ticket == nil {
		return
	}
	ticket.fn = callback
	d.mu.Lock()
	if d.stopping {
		d.mu.Unlock()
		d.finish(ticket)
		return
	}
	d.submitWG.Add(1)
	d.mu.Unlock()
	defer d.submitWG.Done()

	if ticket.prevSubmitted != nil {
		select {
		case <-ticket.prevSubmitted:
		case <-d.stopSubmit:
			d.finish(ticket)
			return
		}
	}

	for {
		d.mu.Lock()
		if d.stopping {
			d.mu.Unlock()
			d.finish(ticket)
			return
		}
		if len(d.pending) < presenceCallbackQueue {
			d.pending = append(d.pending, ticket)
			ticket.markSubmitted()
			d.signalWorkersLocked()
			d.ensureWorkersLocked()
			d.mu.Unlock()
			return
		}
		space := d.spaceAvailable
		d.mu.Unlock()
		select {
		case <-space:
		case <-d.stopSubmit:
			d.finish(ticket)
			return
		}
	}
}

func (d *presenceCallbackDispatcher) ensureWorkersLocked() {
	// Unready same-user successors stay in pending and do not inflate demand.
	desired := d.active + d.runnableCountLocked()
	if desired > presenceCallbackWorkers {
		desired = presenceCallbackWorkers
	}
	for d.workers < desired {
		d.workers++
		d.workerWG.Add(1)
		go d.worker()
	}
}

func (d *presenceCallbackDispatcher) worker() {
	defer d.workerWG.Done()
	timer := time.NewTimer(presenceCallbackIdle)
	defer timer.Stop()
	for {
		d.mu.Lock()
		if d.stopping {
			d.workers--
			d.mu.Unlock()
			return
		}
		index := d.firstRunnableLocked()
		if index >= 0 {
			ticket := d.pending[index]
			copy(d.pending[index:], d.pending[index+1:])
			d.pending[len(d.pending)-1] = nil
			d.pending = d.pending[:len(d.pending)-1]
			d.active++
			d.signalSpaceLocked()
			d.mu.Unlock()
			if timer.Stop() {
				// Timer was stopped before firing.
			} else {
				select {
				case <-timer.C:
				default:
				}
			}
			func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						hubLogger.Error("presence callback panic recovered", "user_id", ticket.userID, "callback", ticket.name)
					}
					d.finish(ticket)
					d.mu.Lock()
					d.active--
					d.signalWorkersLocked()
					d.ensureWorkersLocked()
					d.mu.Unlock()
				}()
				if ticket.fn != nil {
					ticket.fn()
				}
			}()
			timer.Reset(presenceCallbackIdle)
			continue
		}
		wake := d.wakeWorkers
		d.mu.Unlock()
		select {
		case <-wake:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		case <-timer.C:
			d.mu.Lock()
			if !d.stopping && d.firstRunnableLocked() < 0 {
				d.workers--
				d.mu.Unlock()
				return
			}
			d.mu.Unlock()
		}
		timer.Reset(presenceCallbackIdle)
	}
}

func (d *presenceCallbackDispatcher) firstRunnableLocked() int {
	for i, ticket := range d.pending {
		if ticket.prevDone == nil {
			return i
		}
		select {
		case <-ticket.prevDone:
			return i
		default:
		}
	}
	return -1
}

func (d *presenceCallbackDispatcher) runnableCountLocked() int {
	count := 0
	for _, ticket := range d.pending {
		if ticket.prevDone == nil {
			count++
			continue
		}
		select {
		case <-ticket.prevDone:
			count++
		default:
		}
	}
	return count
}

func (d *presenceCallbackDispatcher) signalWorkersLocked() {
	close(d.wakeWorkers)
	d.wakeWorkers = make(chan struct{})
}

func (d *presenceCallbackDispatcher) signalSpaceLocked() {
	close(d.spaceAvailable)
	d.spaceAvailable = make(chan struct{})
}

func (d *presenceCallbackDispatcher) finish(ticket *presenceCallbackTicket) {
	ticket.finish()
	d.mu.Lock()
	delete(d.outstanding, ticket)
	if d.tails[ticket.userID] == ticket {
		delete(d.tails, ticket.userID)
	}
	d.signalWorkersLocked()
	d.mu.Unlock()
}

// shutdown stops admission, releases submitters and queued tickets, and waits
// for in-flight callbacks to return. Call before closing callback dependencies
// such as DB pools. A callback that never returns cannot be canceled.
func (d *presenceCallbackDispatcher) shutdown() {
	d.mu.Lock()
	if d.stopping {
		d.mu.Unlock()
		<-d.shutdownDone
		return
	}
	d.stopping = true
	close(d.stopSubmit)
	var outstanding []*presenceCallbackTicket
	for ticket := range d.outstanding {
		outstanding = append(outstanding, ticket)
	}
	d.tails = make(map[string]*presenceCallbackTicket)
	d.outstanding = make(map[*presenceCallbackTicket]struct{})
	d.pending = nil
	d.signalWorkersLocked()
	d.signalSpaceLocked()
	d.mu.Unlock()
	for _, ticket := range outstanding {
		ticket.finish()
	}
	d.submitWG.Wait()
	d.workerWG.Wait()
	close(d.shutdownDone)
}
