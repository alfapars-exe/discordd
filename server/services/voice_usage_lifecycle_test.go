package services

import (
	"context"
	"testing"
	"time"
)

func TestVoiceUsageCreditHasBoundedContext(t *testing.T) {
	calls := 0
	var observed context.Context
	s := &voiceService{livekitGetter: &mockConfigurableLiveKitGetter{IncrementMonthlyUsageFn: func(ctx context.Context, _ string, _, _, seconds int) error {
		calls++
		observed = ctx
		deadline, ok := ctx.Deadline()
		if !ok {
			t.Error("usage credit database call has no deadline")
			return nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 || remaining > 10*time.Second {
			t.Errorf("usage credit deadline outside bounded budget: %s", remaining)
		}
		if seconds < 59 {
			t.Errorf("session duration lost: %d", seconds)
		}
		return nil
	}}}
	s.creditUsage("instance", true, time.Now().Add(-time.Minute))
	if observed == nil || observed.Err() != context.Canceled {
		t.Error("usage context not released on return")
	}
	if calls != 1 {
		t.Fatalf("usage writes=%d, want 1", calls)
	}
}
