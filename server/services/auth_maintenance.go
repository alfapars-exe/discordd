package services

import (
	"context"
	"time"
)

type authRefreshSweep struct {
	cancel context.CancelFunc
	done   chan struct{}
}

func (s *authService) startRefreshSweep(parent context.Context) func() {
	s.refreshSweepMu.Lock()
	worker := s.refreshSweep
	if worker == nil {
		ctx, cancel := context.WithCancel(parent)
		worker = &authRefreshSweep{cancel: cancel, done: make(chan struct{})}
		s.refreshSweep = worker
		go func() {
			ticker := time.NewTicker(time.Hour)
			defer ticker.Stop()
			defer func() {
				s.refreshSweepMu.Lock()
				if s.refreshSweep == worker {
					s.refreshSweep = nil
				}
				close(worker.done)
				s.refreshSweepMu.Unlock()
			}()
			s.runRefreshSweep(ctx, ticker.C)
		}()
	}
	s.refreshSweepMu.Unlock()
	return func() {
		worker.cancel()
		<-worker.done
	}
}

// The owner controls ticker and cancellation lifetime. Accepting ticks here
// lets lifecycle tests exercise cancellation during a sweep without wall time.
func (s *authService) runRefreshSweep(ctx context.Context, ticks <-chan time.Time) {
	for {
		select {
		case now := <-ticks:
			s.sweepUsedRefresh(now)
		case <-ctx.Done():
			return
		}
	}
}

func (s *authService) sweepUsedRefresh(now time.Time) {
	s.usedRefreshMu.Lock()
	defer s.usedRefreshMu.Unlock()
	for key, entry := range s.usedRefresh {
		if now.After(entry.expiresAt) {
			delete(s.usedRefresh, key)
		}
	}
}
