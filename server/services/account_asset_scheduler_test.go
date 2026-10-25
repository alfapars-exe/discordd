package services

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

type cleanupScheduleRepo struct {
	recover atomic.Bool
	calls   atomic.Int32
}

func (r *cleanupScheduleRepo) Due(context.Context, int64, int) ([]string, error) {
	r.calls.Add(1)
	if !r.recover.Load() {
		return nil, fmt.Errorf("fixture database failure")
	}
	return []string{}, nil
}
func (r *cleanupScheduleRepo) Process(context.Context, string, int64, func() error) (string, error) {
	return "skipped", nil
}
func waitCleanupStatus(t *testing.T, s *AccountAssetCleanup, predicate func(AccountAssetCleanupStatus) bool) {
	t.Helper()
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		if predicate(s.Status()) {
			return
		}
		select {
		case <-deadline.C:
			t.Fatal("cleanup status did not converge", s.Status())
		case <-tick.C:
		}
	}
}
func TestAccountAssetSchedulerReportsFailureRecoveryAndStops(t *testing.T) {
	repo := &cleanupScheduleRepo{}
	worker := NewAccountAssetCleanup(repo, t.TempDir())
	stop := worker.start(context.Background(), 5*time.Millisecond)
	defer stop()
	waitCleanupStatus(t, worker, func(s AccountAssetCleanupStatus) bool {
		return s.Running && s.LastCheckedAt != nil && s.ConsecutiveFailures > 0 && s.LastSuccessAt == nil
	})
	repo.recover.Store(true)
	waitCleanupStatus(t, worker, func(s AccountAssetCleanupStatus) bool {
		return s.Running && s.LastSuccessAt != nil && s.ConsecutiveFailures == 0
	})
	stop()
	if worker.Status().Running {
		t.Fatal("scheduler still running after stop")
	}
	stop()
	// A stopped instance can be restarted; a second Start shares that loop.
	restart := worker.start(context.Background(), time.Hour)
	duplicateStop := worker.Start(context.Background())
	waitCleanupStatus(t, worker, func(s AccountAssetCleanupStatus) bool { return s.Running && s.LastCheckedAt != nil })
	duplicateStop()
	restart()
	if worker.Status().Running {
		t.Fatal("duplicate start left an extra loop")
	}
}
