package services

import (
	"context"
	"testing"
	"time"

	"github.com/argeinfina/hichat/repository"
)

func TestAuthMaintenanceExplicitLifecycle(t *testing.T) {
	s := NewAuthService(nil, nil, nil, nil, nil, "", 1, 1).(*authService)
	if s.refreshSweep != nil {
		t.Fatal("constructor started background work")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := StartAuthMaintenance(ctx, s)
	s.refreshSweepMu.Lock()
	first := s.refreshSweep
	s.refreshSweepMu.Unlock()
	secondStop := StartAuthMaintenance(ctx, s)
	s.refreshSweepMu.Lock()
	if s.refreshSweep != first {
		t.Error("duplicate start replaced the active worker")
	}
	s.refreshSweepMu.Unlock()
	cancel()
	select {
	case <-first.done:
	case <-time.After(time.Second):
		t.Fatal("canceled worker did not stop")
	}
	stop()
	secondStop()
	stop()

	stopAgain := StartAuthMaintenance(context.Background(), s)
	s.refreshSweepMu.Lock()
	replacement := s.refreshSweep
	s.refreshSweepMu.Unlock()
	if replacement == nil || replacement == first {
		t.Fatal("stopped service could not restart")
	}
	stopAgain()
}

func TestAuthMaintenanceDurableSessionsDoNotStartLegacyWorker(t *testing.T) {
	s := NewAuthService(nil, nil, nil, nil, nil, "", 1, 1, WithAuthSessions(repository.NewSQLiteAuthSessionRepo(nil))).(*authService)
	stop := StartAuthMaintenance(context.Background(), s)
	stop()
	if s.refreshSweep != nil {
		t.Fatal("durable sessions started an unused cache worker")
	}
}

func TestAuthSweepPreservesUnexpiredReuseEvidence(t *testing.T) {
	now := time.Unix(1000, 0)
	s := &authService{usedRefresh: map[string]usedRefreshEntry{
		"expired":  {expiresAt: now.Add(-time.Second)},
		"boundary": {expiresAt: now},
		"live":     {expiresAt: now.Add(time.Second)},
	}}
	s.sweepUsedRefresh(now)
	if _, found := s.usedRefresh["expired"]; found || len(s.usedRefresh) != 2 {
		t.Fatal("sweep removed valid evidence or retained expired evidence")
	}
}
