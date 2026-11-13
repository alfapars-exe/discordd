package services

import (
	"sync"
	"time"
)

// voiceMaintenanceWorker is terminal: stopping before or after start prevents
// future starts. Its owner waits for any current sweep before releasing stores.
type voiceMaintenanceWorker struct {
	mu      sync.Mutex
	stopped bool
	done    chan struct{}
	cancel  chan struct{}
}

func (w *voiceMaintenanceWorker) start(interval time.Duration, sweep func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped || w.done != nil {
		return
	}
	w.done = make(chan struct{})
	w.cancel = make(chan struct{})
	go func() {
		defer close(w.done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-w.cancel:
				return
			case <-ticker.C:
				select {
				case <-w.cancel:
					return
				default:
				}
				sweep()
			}
		}
	}()
}

func (w *voiceMaintenanceWorker) stop() {
	w.mu.Lock()
	if !w.stopped {
		w.stopped = true
		if w.cancel != nil {
			close(w.cancel)
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
