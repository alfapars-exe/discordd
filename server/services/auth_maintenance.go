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
			for {
				select {
				case now := <-ticker.C:
					s.sweepUsedRefresh(now)
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	s.refreshSweepMu.Unlock()
	return func() {
		worker.cancel()
		<-worker.done
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
