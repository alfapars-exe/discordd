package services

import (
	"context"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

const (
	serverEventWorkerInterval       = 15 * time.Second
	serverEventWorkerTimeout        = 10 * time.Second
	serverEventWorkerEventPageLimit = 50
	serverEventWorkerUserPageLimit  = 100
	serverEventWorkerDrainPages     = 20
)

// serverEventDeliveryRepository atomically chooses currently due events and
// persists at most one notification per eligible RSVP. Deliver returns nil
// when the event is stale/ineligible or the notification was already created.
// ServerEventWorker delivers upcoming-event notifications without holding a
// database transaction while broadcasting. Event and recipient cursors are
// keyset-based and retained across ticks to avoid starving later rows.
type ServerEventWorker struct {
	repo repository.ServerEventDeliveryRepository
	hub  ws.Broadcaster
	now  func() time.Time

	mu              sync.Mutex
	eventCursor     string
	selectedEvent   *models.ServerEvent
	recipientCursor string
	cancel          context.CancelFunc
	done            chan struct{}
}

func NewServerEventWorker(repo repository.ServerEventDeliveryRepository, hub ws.Broadcaster) *ServerEventWorker {
	return &ServerEventWorker{repo: repo, hub: hub, now: time.Now}
}

// Start begins the bounded 15-second delivery loop and returns a function
// that cancels it and waits for the worker goroutine to finish.
func (w *ServerEventWorker) Start(parent context.Context) func() {
	w.mu.Lock()
	if w.cancel != nil {
		cancel, done := w.cancel, w.done
		w.mu.Unlock()
		return func() { cancel(); <-done }
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	w.cancel, w.done = cancel, done
	w.mu.Unlock()
	logx.Go("server_event_notifications", func() {
		defer func() {
			w.mu.Lock()
			w.cancel = nil
			close(done)
			w.mu.Unlock()
		}()
		ticker := time.NewTicker(serverEventWorkerInterval)
		defer ticker.Stop()
		for {
			if err := w.Drain(ctx); err != nil && ctx.Err() == nil {
				logx.Component("server_event_notifications").Warn("event notification delivery failed", "err", pkg.ErrText(err))
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
	return func() { cancel(); <-done }
}

// Drain advances multiple bounded pages within one shared time budget. Large
// events do not have to wait another 15 seconds for every 100 attendees.
// Cursors remain intact when the budget is exhausted, so the next run resumes.
func (w *ServerEventWorker) Drain(ctx context.Context) error {
	bounded, cancel := context.WithTimeout(ctx, serverEventWorkerTimeout)
	defer cancel()
	for page := 0; page < serverEventWorkerDrainPages; page++ {
		if err := w.Tick(bounded); err != nil {
			return err
		}
		w.mu.Lock()
		wrapped := w.selectedEvent == nil && w.eventCursor == ""
		w.mu.Unlock()
		if wrapped {
			return nil
		}
	}
	return nil
}

// Tick processes at most one event and one bounded recipient page. Calling
// it again continues from the next user/event key without restarting at the
// first RSVP. A due candidate is refreshed on every tick before paging users.
func (w *ServerEventWorker) Tick(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	bounded, cancel := context.WithTimeout(ctx, serverEventWorkerTimeout)
	defer cancel()
	now := w.now().UTC()

	w.mu.Lock()
	defer w.mu.Unlock()
	if err := bounded.Err(); err != nil {
		return err
	}
	candidates, err := w.repo.DueCandidates(bounded, now, serverEventWorkerEventPageLimit, w.eventCursor)
	if err != nil {
		return err
	}
	if w.selectedEvent == nil {
		if len(candidates) == 0 {
			// Wrap after reaching the end, allowing events that became due since
			// the last pass to be picked up on the next tick.
			w.eventCursor = ""
			return nil
		}
		selected := candidates[0]
		w.selectedEvent = &selected
		w.recipientCursor = ""
	} else {
		refreshed := false
		for i := range candidates {
			if candidates[i].ID == w.selectedEvent.ID {
				selected := candidates[i]
				w.selectedEvent = &selected
				refreshed = true
				break
			}
		}
		if !refreshed {
			w.eventCursor = w.selectedEvent.ID
			w.selectedEvent = nil
			w.recipientCursor = ""
			return nil
		}
	}

	users, err := w.repo.InterestedPage(bounded, w.selectedEvent.ID, w.recipientCursor, serverEventWorkerUserPageLimit)
	if err != nil {
		return err
	}
	if len(users) == 0 {
		w.eventCursor = w.selectedEvent.ID
		w.selectedEvent = nil
		w.recipientCursor = ""
		return nil
	}
	var firstDeliveryErr error
	for _, userID := range users {
		if err := bounded.Err(); err != nil {
			return err
		}
		// A page can take seconds to deliver. Use the current clock for each
		// recipient so an event that starts mid-page stops being eligible.
		notification, deliverErr := w.repo.Deliver(bounded, w.selectedEvent.ID, w.selectedEvent.Version, userID, w.now().UTC())
		if deliverErr != nil {
			if firstDeliveryErr == nil {
				firstDeliveryErr = deliverErr
			}
			// Advance this bounded page despite a single recipient's failure.
			// The next full event-cursor wrap starts the recipient scan over,
			// retrying that user without blocking other attendees.
			w.recipientCursor = userID
			continue
		}
		if notification != nil {
			broadcastNotificationCreate(w.hub, notification)
		}
		w.recipientCursor = userID
	}
	if len(users) < serverEventWorkerUserPageLimit {
		w.eventCursor = w.selectedEvent.ID
		w.selectedEvent = nil
		w.recipientCursor = ""
	}
	return firstDeliveryErr
}
