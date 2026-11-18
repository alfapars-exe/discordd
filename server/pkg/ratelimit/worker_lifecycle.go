package ratelimit

import "sync"

// cleanupWorker owns a limiter's maintenance loop. Stopping maintenance does
// not erase budgets, so requests already draining retain rate enforcement.
type cleanupWorker struct {
	stopCleanup chan struct{}
	cleanupDone chan struct{}
	stopOnce    sync.Once
}

func newCleanupWorker() cleanupWorker {
	return cleanupWorker{stopCleanup: make(chan struct{}), cleanupDone: make(chan struct{})}
}

// Stop waits for the cleanup loop and its ticker to exit. Concurrent and
// repeated callers share the same completion signal.
func (w *cleanupWorker) Stop() {
	w.stopOnce.Do(func() { close(w.stopCleanup) })
	<-w.cleanupDone
}
