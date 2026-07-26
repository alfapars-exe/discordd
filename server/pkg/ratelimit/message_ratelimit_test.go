package ratelimit

import (
	"testing"
	"time"
)

// Sliding-window semantics for the chat message limiter (cooldown == 0).
//
// The old fixed window + 15s hard lockout was the direct cause of the
// "sending sometimes freezes" complaint: six quick lines cost a 15-second
// block. These tests pin the replacement contract — the pace is capped, but
// sending resumes the moment the oldest timestamp ages out, and there is no
// punitive lockout in this mode.

func TestMessageLimiter_SlidingWindowNoLockout(t *testing.T) {
	rl := NewMessageRateLimiter(3, 1*time.Second, 0)
	const user = "u"

	for i := 0; i < 3; i++ {
		if !rl.Allow(user) {
			t.Fatalf("Allow #%d = false, want true", i+1)
		}
	}
	if rl.Allow(user) {
		t.Fatal("4th Allow inside the window = true, want false")
	}
	// Retry-After must report when the oldest send ages out, not zero.
	if got := rl.CooldownSeconds(user); got < 1 {
		t.Errorf("CooldownSeconds while capped = %d, want >= 1", got)
	}

	// No hard lockout: once the window drains, sending resumes immediately.
	time.Sleep(1100 * time.Millisecond)
	if !rl.Allow(user) {
		t.Fatal("Allow after window drained = false — sliding mode must not lock out")
	}
}

func TestMessageLimiter_WindowActuallySlides(t *testing.T) {
	rl := NewMessageRateLimiter(2, 1*time.Second, 0)
	const user = "u"

	rl.Allow(user) // t≈0
	time.Sleep(600 * time.Millisecond)
	rl.Allow(user) // t≈600ms
	if rl.Allow(user) {
		t.Fatal("3rd send with 2 in the trailing window must be blocked")
	}

	// t≈1100ms: the FIRST send has aged out, the second has not. A fixed
	// window anchored at t=0 would have reset entirely; sliding admits
	// exactly one more.
	time.Sleep(500 * time.Millisecond)
	if !rl.Allow(user) {
		t.Fatal("send after oldest aged out must pass")
	}
	if rl.Allow(user) {
		t.Fatal("window must still hold 2 recent sends — extra send admitted")
	}
}

func TestMessageLimiter_CooldownModeStillLocksOut(t *testing.T) {
	// cooldown > 0 preserves the punitive behavior for uploads/feedback:
	// exceeding the cap trips a hard lockout for the full cooldown, even
	// after the window itself has drained.
	rl := NewMessageRateLimiter(2, 100*time.Millisecond, 1*time.Hour)
	const user = "u"

	rl.Allow(user)
	rl.Allow(user)
	if rl.Allow(user) {
		t.Fatal("3rd send must trip the cooldown")
	}
	time.Sleep(150 * time.Millisecond) // window drained, cooldown has not
	if rl.Allow(user) {
		t.Fatal("cooldown mode must stay locked after the window drains")
	}
	if got := rl.CooldownSeconds(user); got < 3000 {
		t.Errorf("CooldownSeconds = %d, want the remaining hard lockout (~3600)", got)
	}
}
