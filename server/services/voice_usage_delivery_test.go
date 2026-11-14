package services

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

type pendingUsageGetter struct {
	mockConfigurableLiveKitGetter
	apply func(context.Context) (bool, error)
}

func (g *pendingUsageGetter) ApplyNextVoiceUsage(ctx context.Context) (bool, error) {
	return g.apply(ctx)
}

func TestVoiceUsageDeliveryStopCancelsAndJoins(t *testing.T) {
	entered, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	getter := &pendingUsageGetter{apply: func(ctx context.Context) (bool, error) {
		calls.Add(1)
		close(entered)
		<-ctx.Done()
		close(cancelled)
		<-release
		return false, ctx.Err()
	}}
	s := &voiceService{livekitGetter: getter}
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := startVoiceUsageDelivery(parent, s, time.Millisecond)
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("usage worker did not start")
	}
	done := make(chan struct{})
	go func() { stop(); close(done) }()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel pending query")
	}
	select {
	case <-done:
		t.Fatal("Stop returned before pending query completed")
	default:
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Stop did not join worker")
	}
	if parent.Err() != nil {
		t.Fatal("Stop cancelled caller context")
	}
	stop()
	if calls.Load() != 1 {
		t.Fatalf("calls=%d, want1", calls.Load())
	}
}

func TestVoiceUsageDeliveryBatchIsBounded(t *testing.T) {
	calls := 0
	s := &voiceService{livekitGetter: &pendingUsageGetter{apply: func(context.Context) (bool, error) { calls++; return true, nil }}}
	s.deliverPendingVoiceUsage(context.Background())
	if calls != 32 {
		t.Fatalf("batch calls=%d, want32", calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.deliverPendingVoiceUsage(ctx)
	if calls != 32 {
		t.Fatal("cancelled batch called repository")
	}
}
