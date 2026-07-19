package ratelimit

import (
	"testing"
	"time"
)

// UploadRateLimiter config regression pin (T3.5).
//
// The upload limiter's sizing was picked deliberately: 20/min with a
// 30s cooldown lets a legitimate user drop a batch of photos in one go
// (nowhere near 20/min) while making a scripted spam expensive. If a
// future edit accidentally cranks the max down or reshapes the window,
// two failure modes appear:
//
//   - Too tight: users report "I dropped 6 photos and got throttled" —
//     the kind of intermittent complaint that's easy to dismiss until
//     it recurs.
//   - Too loose: an abuser can pin the storage budget silently.
//
// The MessageRateLimiter struct is reused for uploads too. This test
// pins the behavior with the same (20, 1min, 30s) triple the app is
// wired with, so the config drift shows up here first.

func TestUploadLimiter_ConfigAllowsBurstButCapsAtTwenty(t *testing.T) {
	rl := NewMessageRateLimiter(20, 1*time.Minute, 30*time.Second)
	const user = "u"

	// First 20 uploads within the same window all pass.
	for i := 0; i < 20; i++ {
		if !rl.Allow(user) {
			t.Fatalf("Allow #%d returned false, want true — burst limit is too tight", i+1)
		}
	}

	// The 21st should be rejected AND land the user in cooldown.
	if rl.Allow(user) {
		t.Fatal("Allow #21 returned true, want false — upload cap not enforced")
	}
	if got := rl.CooldownSeconds(user); got < 1 {
		t.Errorf("CooldownSeconds after 21st = %d, want >=1", got)
	}
}

func TestUploadLimiter_CooldownIsRoughlyThirtySeconds(t *testing.T) {
	// The 30s cooldown value is user-visible via the Retry-After header
	// on the client toast. A drift down to 5s would flip the UX from
	// "you're rate-limited" to "keep pounding, one will succeed" —
	// enabling the spam it was meant to stop.
	rl := NewMessageRateLimiter(20, 1*time.Minute, 30*time.Second)
	const user = "u"
	for i := 0; i < 21; i++ {
		rl.Allow(user)
	}
	got := rl.CooldownSeconds(user)
	if got < 25 || got > 32 {
		t.Errorf("cooldown seconds = %d, want ~30 (±2s allowance for wall-clock jitter)", got)
	}
}
