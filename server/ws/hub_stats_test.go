// P3.10: Hub.Stats() runtime op counters. These back a slog line
// (startRuntimeStatsLogger in main's health.go), not an HTTP endpoint, so
// the tests here only pin the counters themselves, not any wire format.
package ws

import "testing"

// TestHandleEvent_DispatchCounted pins that a successfully routed op (one
// matching a registered handler) increments DispatchCount exactly once.
func TestHandleEvent_DispatchCounted(t *testing.T) {
	h := NewHub()
	c := &Client{hub: h, userID: "u1", send: make(chan []byte, 4), done: make(chan struct{})}

	c.handleEvent(Event{Op: OpHeartbeat})

	if got := h.Stats().DispatchCount; got != 1 {
		t.Errorf("DispatchCount = %d, want 1", got)
	}
	if got := h.Stats().RateLimitDrops; got != 0 {
		t.Errorf("RateLimitDrops = %d, want 0", got)
	}
}

// TestHandleEvent_UnknownOpNotCountedAsDispatch — an op with no registered
// handler must not inflate DispatchCount; it never reaches a handler.
func TestHandleEvent_UnknownOpNotCountedAsDispatch(t *testing.T) {
	h := NewHub()
	c := &Client{hub: h, userID: "u1", send: make(chan []byte, 4), done: make(chan struct{})}

	c.handleEvent(Event{Op: "not_a_real_op"})

	if got := h.Stats().DispatchCount; got != 0 {
		t.Errorf("DispatchCount = %d, want 0 for an unrecognised op", got)
	}
}

// TestHandleEvent_RateLimitedOpCounted pins that a rate-limit drop is
// reflected in RateLimitDrops and does NOT also count as a dispatch.
func TestHandleEvent_RateLimitedOpCounted(t *testing.T) {
	h := NewHub()
	c := &Client{hub: h, userID: "u1", send: make(chan []byte, 4), done: make(chan struct{})}
	c.rateLimit = newClientRateLimiter()

	// Exhaust the heartbeat bucket, then send one more to trigger the drop.
	for c.rateLimit.allow(OpHeartbeat) {
	}
	c.handleEvent(Event{Op: OpHeartbeat})

	if got := h.Stats().RateLimitDrops; got != 1 {
		t.Errorf("RateLimitDrops = %d, want 1", got)
	}
	if got := h.Stats().DispatchCount; got != 0 {
		t.Errorf("DispatchCount = %d, want 0 — a rate-limited op must not also count as dispatched", got)
	}
}

// TestQueueUnregister_BufferFullCountsDrop pins the queueDrops counter's
// only increment site: queueUnregister's select-default when the buffered
// unregister channel is already full.
func TestQueueUnregister_BufferFullCountsDrop(t *testing.T) {
	h := NewHub()
	// Fill the buffered channel to capacity directly (bypassing
	// queueUnregister itself) so the next call is guaranteed to hit default.
	for i := 0; i < cap(h.unregister); i++ {
		h.unregister <- &Client{}
	}

	h.queueUnregister(&Client{})

	if got := h.Stats().QueueUnregisterDrops; got != 1 {
		t.Errorf("QueueUnregisterDrops = %d, want 1", got)
	}
	if got := h.Stats().QueueUnregisterLen; got != cap(h.unregister) {
		t.Errorf("QueueUnregisterLen = %d, want %d (unchanged by a dropped enqueue)", got, cap(h.unregister))
	}
}
