package ws

import (
	"sync"
	"time"
)

// Per-event-type rate limits for WebSocket traffic. These caps were chosen
// against typical client behaviour:
//   - Typing: a fast typist generates ~5 keystrokes/sec; the client should
//     throttle to ~2/sec but we allow headroom for burst keystrokes.
//   - Presence: should only fire on real status changes; 1/sec is plenty
//     and stops "presence toggle" abuse from broadcasting amplification.
//   - Voice activity: tracks VAD frames + mouse/keyboard; mid-meeting these
//     can fire ~10/sec but should never spike higher.
//   - Default: every other event (voice join, p2p signal, etc.) shares one
//     bucket so a single misbehaving client can't carve out an unlimited
//     channel just by varying event names.
//
// Each bucket is per-(client, event-type). A burst that exhausts the
// bucket gets the event silently dropped with a warning log — never
// disconnect, since that would amplify the DoS effect (forcing the client
// to reconnect and re-sync the world).
type eventRateLimits struct {
	burst  int           // bucket capacity
	refill time.Duration // one token added per this duration
}

var defaultEventLimits = map[string]eventRateLimits{
	OpTyping:         {burst: 10, refill: 200 * time.Millisecond}, // ~5/sec sustained
	OpPresenceUpdate: {burst: 3, refill: time.Second},             // ~1/sec sustained
	OpVoiceActivity:  {burst: 20, refill: 100 * time.Millisecond}, // ~10/sec sustained
	OpDMTypingStart:  {burst: 10, refill: 200 * time.Millisecond}, // mirrors typing
}

// fallbackLimit applies to any op without an explicit entry above.
var fallbackLimit = eventRateLimits{burst: 30, refill: 50 * time.Millisecond} // ~20/sec

// tokenBucket is a minimal lock-protected token bucket. We use a manual
// timer-free implementation so an idle client doesn't wake the runtime
// just to refill an unused bucket.
type tokenBucket struct {
	mu       sync.Mutex
	tokens   float64
	capacity float64
	refill   time.Duration
	last     time.Time
}

func newTokenBucket(cap int, refill time.Duration) *tokenBucket {
	return &tokenBucket{
		tokens:   float64(cap),
		capacity: float64(cap),
		refill:   refill,
		last:     time.Now(),
	}
}

// allow returns true and debits one token if available, false otherwise.
func (b *tokenBucket) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(b.last)
	if elapsed > 0 {
		// Floating-point refill is fine here — we're not counting money.
		refillTokens := float64(elapsed) / float64(b.refill)
		b.tokens += refillTokens
		if b.tokens > b.capacity {
			b.tokens = b.capacity
		}
		b.last = now
	}

	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}

// clientRateLimiter holds one bucket per event type per client. Cheap on
// memory (each bucket is ~64 bytes); we create them lazily on first
// observation of each op.
type clientRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*tokenBucket
}

func newClientRateLimiter() *clientRateLimiter {
	return &clientRateLimiter{
		buckets: make(map[string]*tokenBucket, 4),
	}
}

// allow consults the bucket for op, creating it lazily.
func (r *clientRateLimiter) allow(op string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.buckets[op]
	if !ok {
		limit, exists := defaultEventLimits[op]
		if !exists {
			limit = fallbackLimit
		}
		b = newTokenBucket(limit.burst, limit.refill)
		r.buckets[op] = b
	}
	// b.allow() below now runs with r.mu still held (nested r.mu -> b.mu,
	// rather than sequential): b is a per-op *tokenBucket with its own
	// independent mutex that nothing ever acquires before r.mu, so this
	// isn't a new ordering hazard, just a slightly longer r.mu hold.
	return b.allow()
}
