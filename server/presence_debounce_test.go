package main

import (
	"context"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// Repro-first tests for the presence-flap fix (2026-08-13): a full WS
// disconnect used to write OFFLINE to the DB and broadcast it to every
// client immediately, so a ~1.5s reconnect (the client's normal retry
// floor — see useWebSocket.ts) flapped every online client's presence list
// off and back on. presence_debounce.go delays that transition by a grace
// period so a reconnect within the window cancels it before it ever runs.
//
// Every test below uses a short, injected grace (milliseconds) instead of
// the real 8s presenceOfflineGrace, and synchronizes on channels/direct
// state checks rather than sleeping an arbitrary amount and hoping — the
// only unavoidable real-time wait is bounding how long a test is willing to
// wait for something that legitimately fires after a delay.

// statusCall records one userRepo.UpdateStatus invocation, used to assert
// both that it happened and with which status.
type statusCall struct {
	userID string
	status models.UserStatus
}

// newDebounceTestHub builds a testutil.MockEventPublisher wired to report
// UpdateStatus calls on statusCalls and presence broadcasts on
// broadcastStatuses. GetOnlineUserIDsFn always reports the user as NOT
// connected (nil) unless overridden — the fire-time recheck in
// offlinePresenceTransition would otherwise suppress the very transition
// these tests are asserting on.
func newDebounceTestHub(statusCalls chan statusCall, broadcastStatuses chan string) (*testutil.MockEventPublisher, *testutil.MockUserRepo) {
	hub := &testutil.MockEventPublisher{
		GetOnlineUserIDsFn: func() []string { return nil },
	}
	hub.BroadcastToAllFn = func(event ws.Event) {
		if pd, ok := event.Data.(ws.PresenceData); ok {
			broadcastStatuses <- pd.Status
		}
	}

	userRepo := &testutil.MockUserRepo{
		UpdateStatusFn: func(_ context.Context, id string, status models.UserStatus) error {
			statusCalls <- statusCall{userID: id, status: status}
			return nil
		},
		GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
			return &models.User{ID: id, PrefStatus: models.UserStatusOnline}, nil
		},
	}
	return hub, userRepo
}

// A full disconnect must not write/broadcast OFFLINE before the grace
// period elapses — and must leave a debounce timer pending in the meantime.
func TestPresenceOfflineDebounce_DisconnectDoesNotFireBeforeGrace(t *testing.T) {
	const testGrace = 150 * time.Millisecond
	debouncer := newPresenceOfflineDebouncer(testGrace)
	statusCalls := make(chan statusCall, 4)
	broadcastStatuses := make(chan string, 4)
	hub, userRepo := newDebounceTestHub(statusCalls, broadcastStatuses)

	scheduleOfflinePresenceTransition(debouncer, hub, userRepo, "user-1")

	if !debouncer.pending("user-1") {
		t.Fatal("expected a pending offline debounce timer immediately after a full disconnect")
	}

	select {
	case call := <-statusCalls:
		t.Fatalf("offline transition fired before grace elapsed: %+v", call)
	case status := <-broadcastStatuses:
		t.Fatalf("offline broadcast fired before grace elapsed: %q", status)
	case <-time.After(testGrace / 3):
		// Expected: well under a third of the grace window has passed and
		// nothing has fired yet.
	}
}

// A reconnect within the grace window (userFirstConnectCallback, which
// calls debouncer.cancel) must suppress the OFFLINE transition entirely —
// it must never run, even after the original grace period would have
// elapsed.
func TestPresenceOfflineDebounce_ReconnectWithinGraceCancelsOfflineTransition(t *testing.T) {
	// Generous relative to the synchronous schedule->cancel gap immediately
	// below (sub-millisecond in practice) to keep this robust against
	// scheduler jitter on a loaded CI/Docker host.
	const testGrace = 200 * time.Millisecond
	debouncer := newPresenceOfflineDebouncer(testGrace)
	statusCalls := make(chan statusCall, 4)
	broadcastStatuses := make(chan string, 4)
	hub, userRepo := newDebounceTestHub(statusCalls, broadcastStatuses)

	// Simulate the full-disconnect edge: schedules the debounced OFFLINE
	// transition.
	scheduleOfflinePresenceTransition(debouncer, hub, userRepo, "user-1")

	// Reconnect immediately (well within the grace window) — mirrors the
	// Hub firing OnUserFirstConnect for a new tab/session.
	userFirstConnectCallback(hub, userRepo, debouncer)("user-1", "")

	if debouncer.pending("user-1") {
		t.Fatal("reconnect should have cancelled the pending offline debounce timer")
	}

	// Drain the reconnect's own ONLINE transition first — it goes through
	// the same userRepo.UpdateStatus / hub.BroadcastToAll mock channels.
	select {
	case call := <-statusCalls:
		if call.status != models.UserStatusOnline {
			t.Fatalf("expected reconnect to set status=online, got %v", call.status)
		}
	case <-time.After(time.Second):
		t.Fatal("reconnect never called userRepo.UpdateStatus")
	}
	select {
	case status := <-broadcastStatuses:
		if status != string(models.UserStatusOnline) {
			t.Fatalf("expected reconnect broadcast status=online, got %q", status)
		}
	case <-time.After(time.Second):
		t.Fatal("reconnect never broadcast presence")
	}

	// Now wait comfortably past the original grace period and assert
	// nothing else arrives — the OFFLINE transition must never fire.
	select {
	case call := <-statusCalls:
		t.Fatalf("unexpected extra UpdateStatus call after cancelled disconnect: %+v", call)
	case status := <-broadcastStatuses:
		t.Fatalf("unexpected extra broadcast after cancelled disconnect: %q", status)
	case <-time.After(testGrace * 5):
		// Expected: nothing else fired.
	}
}

// With no reconnect, the OFFLINE transition must fire once the grace period
// elapses — this is the "user really did leave" path, just delayed.
func TestPresenceOfflineDebounce_NoReconnectFiresOfflineAfterGrace(t *testing.T) {
	const testGrace = 40 * time.Millisecond
	debouncer := newPresenceOfflineDebouncer(testGrace)
	statusCalls := make(chan statusCall, 4)
	broadcastStatuses := make(chan string, 4)
	hub, userRepo := newDebounceTestHub(statusCalls, broadcastStatuses)

	start := time.Now()
	scheduleOfflinePresenceTransition(debouncer, hub, userRepo, "user-1")

	select {
	case call := <-statusCalls:
		if call.status != models.UserStatusOffline {
			t.Fatalf("expected status=offline, got %v", call.status)
		}
		if call.userID != "user-1" {
			t.Fatalf("expected userID=user-1, got %q", call.userID)
		}
		if elapsed := time.Since(start); elapsed < testGrace {
			t.Fatalf("offline transition fired before the grace period elapsed: %v < %v", elapsed, testGrace)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("offline transition never fired within a generous margin past the grace period")
	}

	select {
	case status := <-broadcastStatuses:
		if status != string(models.UserStatusOffline) {
			t.Fatalf("expected broadcast status=offline, got %q", status)
		}
	case <-time.After(time.Second):
		t.Fatal("offline broadcast never happened")
	}

	if debouncer.pending("user-1") {
		t.Fatal("timer should have been cleared from the debouncer once it fired")
	}
}

// offlinePresenceTransition's fire-time recheck must skip the DB write and
// broadcast entirely if the hub reports the user as still connected — the
// defense-in-depth path described in its doc comment.
func TestOfflinePresenceTransition_SkipsWhenHubStillReportsConnected(t *testing.T) {
	hub := &testutil.MockEventPublisher{
		GetOnlineUserIDsFn: func() []string { return []string{"user-1"} },
	}
	hub.BroadcastToAllFn = func(event ws.Event) {
		t.Fatalf("must not broadcast when the hub still reports the user connected, got %+v", event)
	}
	userRepo := &testutil.MockUserRepo{
		UpdateStatusFn: func(_ context.Context, _ string, _ models.UserStatus) error {
			t.Fatal("must not write OFFLINE status when the hub still reports the user connected")
			return nil
		},
	}

	offlinePresenceTransition(hub, userRepo, newPresenceOfflineDebouncer(time.Second), "user-1", 1)
}

// A fire whose generation was invalidated (cancel() bumped it after the
// timer left the map) must abort before the DB write — the pre-write
// generation gate from the 2026-08-13 review's TOCTOU finding.
func TestOfflinePresenceTransition_StaleGenerationSkipsWrite(t *testing.T) {
	hub := &testutil.MockEventPublisher{
		GetOnlineUserIDsFn: func() []string { return nil },
	}
	hub.BroadcastToAllFn = func(event ws.Event) {
		t.Fatalf("must not broadcast with a stale generation, got %+v", event)
	}
	userRepo := &testutil.MockUserRepo{
		UpdateStatusFn: func(_ context.Context, _ string, _ models.UserStatus) error {
			t.Fatal("must not write status with a stale generation")
			return nil
		},
	}

	// Fresh debouncer: gens["user-1"] == 0, so generation 99 is stale.
	offlinePresenceTransition(hub, userRepo, newPresenceOfflineDebouncer(time.Second), "user-1", 99)
}

// A reconnect landing DURING the OFFLINE DB write must trigger the ONLINE
// compensation write and suppress the offline broadcast.
func TestOfflinePresenceTransition_ReconnectDuringWriteCompensates(t *testing.T) {
	debouncer := newPresenceOfflineDebouncer(time.Hour)
	// Establish a live generation the transition will consider current.
	debouncer.schedule("user-1", func(uint64) {})
	debouncer.mu.Lock()
	gen := debouncer.gens["user-1"]
	debouncer.mu.Unlock()

	hub := &testutil.MockEventPublisher{
		GetOnlineUserIDsFn: func() []string { return nil },
	}
	hub.BroadcastToAllFn = func(event ws.Event) {
		t.Fatalf("offline broadcast must be suppressed after a mid-write reconnect, got %+v", event)
	}

	var statuses []models.UserStatus
	userRepo := &testutil.MockUserRepo{
		UpdateStatusFn: func(_ context.Context, _ string, status models.UserStatus) error {
			statuses = append(statuses, status)
			if len(statuses) == 1 {
				// Simulate the reconnect racing the write: cancel() bumps
				// the generation while UpdateStatus(offline) is in flight.
				debouncer.cancel("user-1")
			}
			return nil
		},
	}

	offlinePresenceTransition(hub, userRepo, debouncer, "user-1", gen)

	if len(statuses) != 2 || statuses[0] != models.UserStatusOffline || statuses[1] != models.UserStatusOnline {
		t.Fatalf("expected offline write then online compensation, got %v", statuses)
	}
}

// cancel on a userID with nothing pending must be a safe no-op — this is the
// common production path (every ordinary first connect calls it).
func TestPresenceOfflineDebouncer_CancelWithoutPendingIsNoop(t *testing.T) {
	debouncer := newPresenceOfflineDebouncer(time.Second)
	if debouncer.cancel("nobody-waiting") {
		t.Fatal("cancel should report false when nothing was pending")
	}
}

// stopAll must prevent a pending timer from ever firing — the graceful-
// shutdown guarantee (main.go calls this before hub.Shutdown()/db.Close()).
func TestPresenceOfflineDebouncer_StopAllCancelsPendingTimers(t *testing.T) {
	debouncer := newPresenceOfflineDebouncer(30 * time.Millisecond)
	fired := make(chan struct{}, 1)
	debouncer.schedule("user-1", func(uint64) { fired <- struct{}{} })

	debouncer.stopAll()

	if debouncer.pending("user-1") {
		t.Fatal("stopAll should have cleared the pending timer")
	}

	select {
	case <-fired:
		t.Fatal("fire ran after stopAll — a shutdown-time timer must not fire")
	case <-time.After(100 * time.Millisecond):
		// Expected: stopAll's Stop() prevented the callback goroutine from
		// ever starting.
	}
}
