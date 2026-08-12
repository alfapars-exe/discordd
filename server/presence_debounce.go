package main

import (
	"sync"
	"time"
)

// presenceOfflineGrace is the delay between a user's last WebSocket
// connection closing and the OFFLINE presence transition actually being
// persisted to the DB and broadcast to every connected client.
//
// Root cause (presence-flap analysis, 2026-08-13): the client's
// useWebSocket.ts reconnects roughly 1.5s after a dropped connection — its
// own doc comment already assumed the server held a grace period before
// this fix, but it didn't. ws/hub_clients.go's removeClient used to fire
// OnUserFullyDisconnected synchronously the instant a user's last tab
// closed, and the callback below broadcast OFFLINE immediately. Every brief
// network blip (backgrounded tab, wifi/cellular handoff, a proxy reset)
// therefore flapped every online client's presence list off and back on
// within about 1.5s.
//
// 8s sits comfortably above that ~1.5s reconnect floor while staying well
// under the 35s voice-state orphan grace (services/voice_lifecycle.go's
// orphanGracePeriod) — a genuinely-departed user's WS presence should not
// look "more patient" than their voice presence. The DB write (and
// therefore last_seen/status) is delayed by up to this long as a side
// effect; a user who really did leave still ends up offline, just up to 8s
// later than before.
const presenceOfflineGrace = 8 * time.Second

// presenceOfflineDebouncer delays a user's OFFLINE presence transition by a
// grace period so a brief reconnect cancels it before it ever runs. One
// timer per user; scheduling again for a userID that already has a pending
// timer replaces it rather than stacking a second one (the Hub only fires
// OnUserFullyDisconnected once per drain-to-zero, so this shouldn't happen
// in practice, but replacing instead of ignoring keeps the type correct
// even if that invariant ever changes).
//
// Not a DI-style setter (see server/wiring_test.go's completeness check for
// Set* methods) — schedule/cancel/stopAll are per-event operations on state
// owned by one presenceOfflineDebouncer instance, constructed once in
// registerHubCallbacks and captured by the closures that use it.
type presenceOfflineDebouncer struct {
	grace time.Duration

	mu     sync.Mutex
	timers map[string]*time.Timer
}

// newPresenceOfflineDebouncer builds a debouncer with the given grace
// period. Grace is a constructor parameter — not the presenceOfflineGrace
// constant baked in directly — so tests can shrink it to milliseconds
// instead of waiting out the real 8s; production wiring passes
// presenceOfflineGrace.
func newPresenceOfflineDebouncer(grace time.Duration) *presenceOfflineDebouncer {
	return &presenceOfflineDebouncer{
		grace:  grace,
		timers: make(map[string]*time.Timer),
	}
}

// schedule plans fire to run after the grace period unless cancel(userID)
// runs first. Replaces (Stop()s) any timer already pending for userID.
func (d *presenceOfflineDebouncer) schedule(userID string, fire func()) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if existing, ok := d.timers[userID]; ok {
		existing.Stop()
	}

	d.timers[userID] = time.AfterFunc(d.grace, func() {
		d.mu.Lock()
		delete(d.timers, userID)
		d.mu.Unlock()
		fire()
	})
}

// cancel aborts a pending offline debounce for userID, if any. Called on
// reconnect (userFirstConnectCallback) to close the race between a
// reconnect and the grace timer firing. Returns whether a timer was
// actually pending — used by tests, harmless to ignore in production
// (cancel on a fresh connect with nothing pending is the common case).
func (d *presenceOfflineDebouncer) cancel(userID string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()

	existing, ok := d.timers[userID]
	if !ok {
		return false
	}
	existing.Stop()
	delete(d.timers, userID)
	return true
}

// pending reports whether userID currently has a scheduled-but-not-yet-fired
// offline debounce timer. Read-only; used by tests to assert scheduling and
// cancellation deterministically without racing the timer's own clock.
func (d *presenceOfflineDebouncer) pending(userID string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, ok := d.timers[userID]
	return ok
}

// stopAll cancels every pending timer. Called during graceful shutdown
// (main.go) before the dependencies a fired timer would touch — the DB pool
// (db.Close) and the Hub (hub.Shutdown) — are torn down. time.AfterFunc
// only spawns its callback goroutine once the timer actually fires, so
// Stop()ing it here (which succeeds as long as the timer hasn't already
// fired) guarantees no such goroutine starts after shutdown begins, rather
// than merely making one likely.
func (d *presenceOfflineDebouncer) stopAll() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for userID, timer := range d.timers {
		timer.Stop()
		delete(d.timers, userID)
	}
}
