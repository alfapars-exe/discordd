package ws

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func reservePresence(d *presenceCallbackDispatcher, user, name string) *presenceCallbackTicket {
	return d.reserve(user, name)
}

func waitSignal(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func TestPresenceCallbackDispatcherSerializesUsersWithoutBlockingOtherUsers(t *testing.T) {
	d := newPresenceCallbackDispatcher()
	defer d.shutdown()
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	otherFinished := make(chan struct{})
	var mu sync.Mutex
	var order []string

	first := reservePresence(d, "a", "first")
	second := reservePresence(d, "a", "second")
	other := reservePresence(d, "b", "other")
	d.submit(first, func() {
		close(firstStarted)
		<-releaseFirst
		mu.Lock()
		order = append(order, "first")
		mu.Unlock()
	})
	waitSignal(t, firstStarted, "first callback start")
	go d.submit(second, func() {
		mu.Lock()
		order = append(order, "second")
		mu.Unlock()
	})
	go d.submit(other, func() {
		close(otherFinished)
	})
	waitSignal(t, otherFinished, "other user's callback")
	select {
	case <-second.done:
		t.Fatal("same-user successor ran before its predecessor")
	default:
	}
	close(releaseFirst)
	waitSignal(t, second.done, "same-user successor")
	mu.Lock()
	defer mu.Unlock()
	if len(order) != 2 || order[0] != "first" || order[1] != "second" {
		t.Fatalf("callback order = %v, want [first second]", order)
	}
}

func TestPresenceCallbackReadySchedulingSurvivesSameUserPoolSaturation(t *testing.T) {
	d := newPresenceCallbackDispatcher()
	defer d.shutdown()
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	otherFinished := make(chan struct{})
	first := d.reserve("same-user", "blocked-first")
	d.submit(first, func() {
		close(firstStarted)
		<-releaseFirst
	})
	waitSignal(t, firstStarted, "blocked first callback")

	const successors = presenceCallbackWorkers + 2
	chain := make([]*presenceCallbackTicket, successors)
	for i := range chain {
		chain[i] = d.reserve("same-user", "successor")
	}
	submitted := make(chan struct{}, successors)
	for _, ticket := range chain {
		go func(ticket *presenceCallbackTicket) {
			d.submit(ticket, func() {})
			submitted <- struct{}{}
		}(ticket)
	}
	for range chain {
		waitSignal(t, submitted, "same-user ticket admission")
	}
	other := d.reserve("other-user", "independent")
	go d.submit(other, func() { close(otherFinished) })
	waitSignal(t, otherFinished, "independent callback despite same-user saturation")
	close(releaseFirst)
	for _, ticket := range chain {
		waitSignal(t, ticket.done, "same-user callback chain")
	}
}

func TestPresenceCallbackPanicDoesNotPoisonUserChain(t *testing.T) {
	d := newPresenceCallbackDispatcher()
	defer d.shutdown()
	first := d.reserve("u", "panics")
	second := d.reserve("u", "next")
	d.submit(first, func() { panic("test panic") })
	completed := make(chan struct{})
	go d.submit(second, func() { close(completed) })
	waitSignal(t, completed, "callback after panic")
}

func TestPresenceCallbackShutdownCancelsQueuedAndWaitsForActive(t *testing.T) {
	d := newPresenceCallbackDispatcher()
	activeStarted := make(chan struct{})
	releaseActive := make(chan struct{})
	queuedRan := make(chan struct{}, 1)
	active := d.reserve("active", "blocking")
	queued := d.reserve("active", "cancelled")
	go d.submit(active, func() {
		close(activeStarted)
		<-releaseActive
	})
	waitSignal(t, activeStarted, "active callback")
	go d.submit(queued, func() { queuedRan <- struct{}{} })
	shutdownDone := make(chan struct{})
	go func() {
		d.shutdown()
		close(shutdownDone)
	}()
	select {
	case <-shutdownDone:
		t.Fatal("shutdown returned while callback was still active")
	case <-time.After(30 * time.Millisecond):
	}
	close(releaseActive)
	waitSignal(t, shutdownDone, "dispatcher shutdown")
	select {
	case <-queuedRan:
		t.Fatal("queued callback ran after shutdown began")
	default:
	}
	d.mu.Lock()
	got := d.workers
	d.mu.Unlock()
	if got != 0 {
		t.Fatalf("workers after shutdown = %d, want 0", got)
	}
}

func TestPresenceCallbackWorkersExitWhenIdle(t *testing.T) {
	d := newPresenceCallbackDispatcher()
	d.submit(d.reserve("u", "idle"), func() {})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		d.mu.Lock()
		workers := d.workers
		d.mu.Unlock()
		if workers == 0 {
			d.shutdown()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	d.shutdown()
	t.Fatal("worker did not exit after becoming idle")
}

func TestPresenceCallbackCanQueryHubWithoutLockDeadlock(t *testing.T) {
	h := NewHub()
	callbackDone := make(chan struct{})
	h.onPresenceManualUpdate = func(userID, status string, isAuto bool) {
		_ = h.GetOnlineUserIDs()
		close(callbackDone)
	}
	c := presenceClient(h, "u", "online")
	h.addClient(c)
	sendPresenceUpdate(c, "idle", false)
	waitSignal(t, callbackDone, "presence callback querying Hub")
	h.presenceCallbacks.shutdown()
}

func TestHubPresenceCallbacksFollowConnectionLifecycleOrder(t *testing.T) {
	h := NewHub()
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	reconnected := make(chan struct{})
	var mu sync.Mutex
	var callbacks []string
	connectCalls := 0
	h.onUserFirstConnect = func(userID, status string) {
		_ = h.GetOnlineUserIDs()
		mu.Lock()
		connectCalls++
		call := connectCalls
		callbacks = append(callbacks, "connect")
		mu.Unlock()
		if call == 1 {
			close(firstStarted)
			<-releaseFirst
		} else {
			close(reconnected)
		}
	}
	h.onPresenceManualUpdate = func(userID, status string, isAuto bool) {
		mu.Lock()
		callbacks = append(callbacks, "manual")
		mu.Unlock()
	}
	h.onUserFullyDisconnected = func(userID, status string) {
		mu.Lock()
		callbacks = append(callbacks, "disconnect")
		mu.Unlock()
	}

	firstClient := presenceClient(h, "u", "online")
	h.addClient(firstClient)
	waitSignal(t, firstStarted, "initial connect callback")
	manualDone := make(chan struct{})
	go func() {
		sendPresenceUpdate(firstClient, "dnd", false)
		close(manualDone)
	}()
	// The state changes synchronously before the callback submit blocks behind
	// the initial-connect callback; this makes the subsequent disconnect order
	// deterministic.
	deadline := time.Now().Add(2 * time.Second)
	status := ""
	for status != "dnd" && time.Now().Before(deadline) {
		h.mu.RLock()
		status = firstClient.status
		h.mu.RUnlock()
		time.Sleep(time.Millisecond)
	}
	if status != "dnd" {
		t.Fatal("manual presence state was not applied")
	}
	removeDone := make(chan struct{})
	go func() {
		h.removeClient(firstClient)
		close(removeDone)
	}()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		h.mu.RLock()
		remaining := len(h.clients["u"])
		h.mu.RUnlock()
		if remaining == 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	h.mu.RLock()
	remaining := len(h.clients["u"])
	h.mu.RUnlock()
	if remaining != 0 {
		t.Fatal("disconnect state was not applied")
	}
	addDone := make(chan struct{})
	go func() {
		h.addClient(presenceClient(h, "u", "online"))
		close(addDone)
	}()
	close(releaseFirst)
	waitSignal(t, reconnected, "reconnect callback")
	waitSignal(t, manualDone, "manual callback completion")
	waitSignal(t, removeDone, "disconnect callback completion")
	waitSignal(t, addDone, "reconnect submission completion")
	mu.Lock()
	defer mu.Unlock()
	want := []string{"connect", "manual", "disconnect", "connect"}
	if len(callbacks) != len(want) {
		t.Fatalf("callbacks = %v, want %v", callbacks, want)
	}
	for i := range want {
		if callbacks[i] != want[i] {
			t.Fatalf("callbacks = %v, want %v", callbacks, want)
		}
	}
	h.presenceCallbacks.shutdown()
}

func TestCommitPresenceVisibilityRejectsStaleCallbackAndPreservesHiddenOnFailedReveal(t *testing.T) {
	h := NewHub()
	c := presenceClient(h, "u", "online")
	h.addClient(c)
	sendPresenceUpdate(c, "offline", false)
	if !h.IsInvisible("u") {
		t.Fatal("manual offline did not hide user immediately")
	}

	// A delayed online persistence callback cannot reveal after a newer
	// offline preference has taken effect.
	if h.CommitPresenceVisibility("u", "online") {
		t.Fatal("stale online commit was accepted")
	}
	if !h.IsInvisible("u") {
		t.Fatal("stale online commit revealed offline user")
	}

	// A new online preference remains hidden until persistence explicitly
	// commits the matching value; a failed update therefore stays concealed.
	sendPresenceUpdate(c, "online", false)
	if !h.IsInvisible("u") {
		t.Fatal("online preference revealed before its persistence commit")
	}
	if !h.CommitPresenceVisibility("u", "online") {
		t.Fatal("matching online commit was rejected")
	}
	if h.IsInvisible("u") {
		t.Fatal("committed online preference remained hidden")
	}
	h.presenceCallbacks.shutdown()
}

func TestHubShutdownClosesClientAdmissionAndPresenceUpdates(t *testing.T) {
	h := NewHub()
	callbackStarted := make(chan struct{})
	releaseCallback := make(chan struct{})
	var callbackCount atomic.Int32
	h.onUserFirstConnect = func(userID, status string) {
		callbackCount.Add(1)
		close(callbackStarted)
		<-releaseCallback
	}
	h.onPresenceManualUpdate = func(userID, status string, isAuto bool) {
		callbackCount.Add(1)
	}
	first := presenceClient(h, "existing", "online")
	h.addClient(first)
	waitSignal(t, callbackStarted, "first-connect callback")

	shutdownDone := make(chan struct{})
	go func() {
		h.Shutdown()
		close(shutdownDone)
	}()
	deadline := time.Now().Add(2 * time.Second)
	shuttingDown := false
	for !shuttingDown && time.Now().Before(deadline) {
		h.mu.RLock()
		shuttingDown = h.shuttingDown
		h.mu.RUnlock()
		time.Sleep(time.Millisecond)
	}
	if !shuttingDown {
		t.Fatal("Hub did not close admission before draining callbacks")
	}

	late := presenceClient(h, "late", "online")
	late.registered = make(chan struct{})
	h.addClient(late)
	select {
	case <-late.registered:
	default:
		t.Fatal("rejected client's registration waiter was not released")
	}
	select {
	case <-late.done:
	default:
		t.Fatal("rejected client's sender was not closed")
	}
	h.mu.RLock()
	_, latePresent := h.clients["late"]
	h.mu.RUnlock()
	if latePresent {
		t.Fatal("client joined while Hub shutdown was draining")
	}

	sendPresenceUpdate(first, "dnd", false)
	if first.status != "online" || first.prefStatus != "online" {
		t.Fatalf("presence update mutated during shutdown: status=%q pref=%q", first.status, first.prefStatus)
	}
	select {
	case <-shutdownDone:
		t.Fatal("shutdown returned before active callback completed")
	case <-time.After(20 * time.Millisecond):
	}
	close(releaseCallback)
	waitSignal(t, shutdownDone, "Hub shutdown")

	after := presenceClient(h, "after", "online")
	after.registered = make(chan struct{})
	h.addClient(after)
	select {
	case <-after.done:
	default:
		t.Fatal("post-shutdown client was not closed")
	}
	h.mu.RLock()
	_, afterPresent := h.clients["after"]
	h.mu.RUnlock()
	if afterPresent {
		t.Fatal("client joined after Hub shutdown")
	}
	if got := callbackCount.Load(); got != 1 {
		t.Fatalf("callback count = %d, want only initial callback", got)
	}
}
