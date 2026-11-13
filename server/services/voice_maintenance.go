package services

import (
	"context"
	"sync"
	"time"
)

// voiceMaintenanceWorker is terminal: stopping before or after start prevents
// future starts. Its owner waits for any current sweep before releasing stores.
type voiceMaintenanceWorker struct {
	mu      sync.Mutex
	stopped bool
	done    chan struct{}
	cancel  context.CancelFunc
}

func (w *voiceMaintenanceWorker) start(interval time.Duration, sweep func()) {
	w.startContext(interval, func(context.Context) { sweep() })
}

func (w *voiceMaintenanceWorker) startContext(interval time.Duration, sweep func(context.Context)) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped || w.done != nil {
		return
	}
	w.done = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	w.cancel = cancel
	go func() {
		defer close(w.done)
		defer cancel()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if ctx.Err() != nil {
					return
				}
				sweep(ctx)
			}
		}
	}()
}

func (w *voiceMaintenanceWorker) stop() {
	w.mu.Lock()
	if !w.stopped {
		w.stopped = true
		if w.cancel != nil {
			w.cancel()
		}
	}
	done := w.done
	w.mu.Unlock()
	if done != nil {
		<-done
	}
}

// StopMaintenance joins orphan and AFK sweeps; active media is owned separately.
func (s *voiceService) StopMaintenance() {
	s.orphanWorker.stop()
	s.afkWorker.stop()
}
