// MessageRateLimiter provides per-user message spam protection.
//
// Differs from LoginRateLimiter:
//   - Keyed by userID (not IP) since the endpoint is authenticated.
//   - Sliding window: each user keeps the timestamps of their recent sends;
//     a send is allowed while fewer than maxMessages fall inside the
//     trailing window. The old fixed window let a burst late in one window
//     ride into the next; worse, its hard lockout punished fast-but-normal
//     typists with a 15s freeze that read as "sending is stuck".
//
// Two operating modes, chosen by the cooldown parameter:
//   - cooldown > 0 (uploads, feedback): exceeding the limit ALSO triggers a
//     hard lockout for the cooldown duration — abuse-shaped endpoints keep
//     their punitive behavior.
//   - cooldown == 0 (chat messages): no lockout. The user can send again as
//     soon as the oldest timestamp ages out of the window, so the worst
//     case is a pace cap, never a multi-second freeze.
package ratelimit

import (
	"sync"
	"time"
)

type messageBucket struct {
	times         []time.Time // send timestamps inside the sliding window, oldest first
	cooldownUntil time.Time   // zero = no cooldown
}

// prune drops timestamps that have aged out of the sliding window.
func (b *messageBucket) prune(now time.Time, window time.Duration) {
	cutoff := now.Add(-window)
	i := 0
	for i < len(b.times) && !b.times[i].After(cutoff) {
		i++
	}
	if i > 0 {
		b.times = append(b.times[:0], b.times[i:]...)
	}
}

type MessageRateLimiter struct {
	mu          sync.Mutex
	buckets     map[string]*messageBucket
	maxMessages int
	window      time.Duration
	cooldown    time.Duration
	stopCleanup chan struct{}
}

func NewMessageRateLimiter(maxMessages int, window, cooldown time.Duration) *MessageRateLimiter {
	rl := &MessageRateLimiter{
		buckets:     make(map[string]*messageBucket),
		maxMessages: maxMessages,
		window:      window,
		cooldown:    cooldown,
		stopCleanup: make(chan struct{}),
	}

	go rl.cleanupLoop()

	return rl
}

// Allow checks if the user can send a message.
// Flow: cooldown active → reject; otherwise allow while fewer than
// maxMessages timestamps remain inside the trailing window.
func (rl *MessageRateLimiter) Allow(userID string) bool {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, exists := rl.buckets[userID]
	if !exists {
		rl.buckets[userID] = &messageBucket{times: []time.Time{now}}
		return true
	}

	if !b.cooldownUntil.IsZero() {
		if now.Before(b.cooldownUntil) {
			return false
		}
		// Lockout expired — forgive the whole window (mirrors the previous
		// "cooldown expired → fresh window" semantics).
		b.times = b.times[:0]
		b.cooldownUntil = time.Time{}
	}

	b.prune(now, rl.window)

	if len(b.times) >= rl.maxMessages {
		if rl.cooldown > 0 {
			b.cooldownUntil = now.Add(rl.cooldown)
		}
		return false
	}

	b.times = append(b.times, now)
	return true
}

// CooldownSeconds returns the wait in seconds for the Retry-After header.
// With a hard lockout active it reports the remaining lockout; in sliding-
// window mode (cooldown == 0) it reports when the oldest send ages out of
// the window — the moment the next Allow would succeed.
func (rl *MessageRateLimiter) CooldownSeconds(userID string) int {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, exists := rl.buckets[userID]
	if !exists {
		return 0
	}

	if !b.cooldownUntil.IsZero() {
		remaining := b.cooldownUntil.Sub(now)
		if remaining <= 0 {
			return 0
		}
		return int(remaining.Seconds()) + 1
	}

	b.prune(now, rl.window)
	if len(b.times) < rl.maxMessages {
		return 0
	}
	remaining := b.times[0].Add(rl.window).Sub(now)
	if remaining <= 0 {
		return 0
	}
	return int(remaining.Seconds()) + 1
}

func (rl *MessageRateLimiter) cleanupLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rl.cleanup()
		case <-rl.stopCleanup:
			return
		}
	}
}

// cleanup removes buckets whose window has fully drained and whose cooldown
// has expired.
func (rl *MessageRateLimiter) cleanup() {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	for userID, b := range rl.buckets {
		b.prune(now, rl.window)
		cooldownExpired := b.cooldownUntil.IsZero() || now.After(b.cooldownUntil)

		if len(b.times) == 0 && cooldownExpired {
			delete(rl.buckets, userID)
		}
	}
}
