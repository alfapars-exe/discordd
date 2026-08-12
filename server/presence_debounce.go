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
	// gens is a per-user generation counter, bumped by every schedule() and
	// cancel(). A fired callback captures the generation it was scheduled
	// with and re-validates it (current()) before each externally visible
	// side effect — that is what shrinks the recheck→DB-write→broadcast
	// TOCTOU window (review 2026-08-13, LOW) to the mutex itself: a
	// reconnect's cancel() bumps the generation, so an in-flight fire
	// observes staleness instead of broadcasting a bogus OFFLINE last.
	gens map[string]uint64
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
		gens:   make(map[string]uint64),
	}
}

// schedule plans fire to run after the grace period unless cancel(userID)
// runs first. Replaces (Stop()s) any timer already pending for userID. The
// generation passed to fire identifies THIS scheduling; fire must gate its
// side effects on current(userID, gen).
func (d *presenceOfflineDebouncer) schedule(userID string, fire func(gen uint64)) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if existing, ok := d.timers[userID]; ok {
		existing.Stop()
	}

	d.gens[userID]++
	gen := d.gens[userID]

	d.timers[userID] = time.AfterFunc(d.grace, func() {
		d.mu.Lock()
		if d.gens[userID] != gen {
			// A cancel() or a fresh schedule() superseded this timer after
			// it had already committed to firing (Timer.Stop's documented
			// "may have already started" caveat) — do nothing.
			d.mu.Unlock()
			return
		}
		delete(d.timers, userID)
		d.mu.Unlock()
		fire(gen)
	})
}

// current reports whether gen is still the live generation for userID —
// i.e. no cancel() or newer schedule() has superseded the scheduling that
// produced it. Fired callbacks call this immediately before each side
// effect.
func (d *presenceOfflineDebouncer) current(userID string, gen uint64) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.gens[userID] == gen
}

// cancel aborts a pending offline debounce for userID, if any. Called on
// reconnect (userFirstConnectCallback) to close the race between a
// reconnect and the grace timer firing. Returns whether a timer was
// actually pending — used by tests, harmless to ignore in production
// (cancel on a fresh connect with nothing pending is the common case).
func (d *presenceOfflineDebouncer) cancel(userID string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Bumping the generation even when no timer is pending is deliberate:
	// it also invalidates a fire that has already left the timers map and
	// is mid-flight in offlinePresenceTransition.
	d.gens[userID]++

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
// (db.Close) and the Hub (hub.Shutdown) — are torn down. Stop()ing here
// ensures no NEW timer goroutine starts after shutdown begins; a callback
// that had already committed to firing microseconds earlier is not joined,
// but the generation bump below invalidates it (current() turns false), and
// even its worst-case pre-gen side effects were verified benign against a
// closed DB / drained hub (error-logged, no panic).
func (d *presenceOfflineDebouncer) stopAll() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for userID, timer := range d.timers {
		timer.Stop()
		delete(d.timers, userID)
		d.gens[userID]++
	}
}
