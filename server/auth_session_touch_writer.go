package main

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
)

const (
	authSessionTouchQueueSize = 1024
	authSessionTouchBudget    = 5 * time.Second
)

var authSessionLogger = logx.Component("auth-session")

// Session last-active timestamps are best-effort bookkeeping. Keep their
// database write off the authenticated request path, where it would cost
// every first request after a quiet minute one more round trip and commit.
// Touches coalesce by session, so a request burst leaves one pending write.
//
// Bound: one goroutine drains one touch per database round trip (roughly
// 9-25 a second on a 40-115 ms link) with authSessionTouchQueueSize distinct
// sessions waiting at most. A session list read meanwhile shows other
// devices' rows as stale as their queued touch is old. Beyond the queue the
// touch is dropped and counted (reportDropped); the read that asked for it
// still reports its own session as active (GetActive, repository package).
type authSessionTouchWriter struct {
	mu       sync.Mutex
	stopped  bool
	pending  map[string]repository.AuthSessionTouch
	queue    chan string
	cancel   context.CancelFunc
	done     chan struct{}
	stopOnce sync.Once
	dropped  atomic.Uint64
}

func newAuthSessionTouchWriter(write func(context.Context, repository.AuthSessionTouch)) *authSessionTouchWriter {
	ctx, cancel := context.WithCancel(context.Background())
	w := &authSessionTouchWriter{
		pending: make(map[string]repository.AuthSessionTouch),
		queue:   make(chan string, authSessionTouchQueueSize),
		cancel:  cancel, done: make(chan struct{}),
	}
	logx.Go("auth-session-touch-writer", func() {
		defer close(w.done)
		defer w.reportDropped()
		report := time.NewTicker(time.Minute)
		defer report.Stop()
		for {
			select {
			case <-ctx.Done():
				w.dropped.Add(uint64(len(w.queue)))
				return
			case <-report.C:
				w.reportDropped()
			case sessionID, ok := <-w.queue:
				if !ok {
					return
				}
				if ctx.Err() != nil {
					w.dropped.Add(uint64(len(w.queue) + 1))
					return
				}
				touch := w.take(sessionID)
				logx.Run("auth-session-touch", func() {
					workCtx, workCancel := context.WithTimeout(ctx, authSessionTouchBudget)
					defer workCancel()
					write(workCtx, touch)
				})
			}
		}
	})
	return w
}

// enqueue never blocks. A session already waiting keeps its queue slot and
// only advances its timestamp; a full queue drops the touch, which merely
// leaves last_active_at stale until the session's next request.
func (w *authSessionTouchWriter) enqueue(touch repository.AuthSessionTouch) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return false
	}
	if queued, ok := w.pending[touch.SessionID]; ok {
		if touch.At > queued.At {
			w.pending[touch.SessionID] = touch
		}
		return true
	}
	select {
	case w.queue <- touch.SessionID:
		w.pending[touch.SessionID] = touch
		return true
	default:
		w.dropped.Add(1)
		return false
	}
}

func (w *authSessionTouchWriter) take(sessionID string) repository.AuthSessionTouch {
	w.mu.Lock()
	defer w.mu.Unlock()
	touch := w.pending[sessionID]
	delete(w.pending, sessionID)
	return touch
}

// reportDropped logs at Info, not Debug: dropped touches mean the queue was
// full (or the writer was stopping), which an operator running at the default
// level has no other way to see.
func (w *authSessionTouchWriter) reportDropped() {
	if count := w.dropped.Swap(0); count > 0 {
		authSessionLogger.Info("auth session touches dropped", "area", "auth", "count", count)
	}
}

// Stop closes admission and drains for one bounded budget. On timeout, cancel
// the in-flight database operation and discard remaining touches. Waiting for
// done guarantees the database can close safely afterwards.
func (w *authSessionTouchWriter) stop() {
	w.stopOnce.Do(func() {
		w.mu.Lock()
		w.stopped = true
		close(w.queue)
		w.mu.Unlock()
		timer := time.NewTimer(authSessionTouchBudget)
		defer timer.Stop()
		select {
		case <-w.done:
		case <-timer.C:
			w.cancel()
			<-w.done
		}
		w.cancel()
	})
}

func authSessionTouchWrite(db database.TxQuerier) func(context.Context, repository.AuthSessionTouch) {
	return func(ctx context.Context, touch repository.AuthSessionTouch) {
		if _, err := repository.TouchAuthSession(ctx, db, touch); err != nil {
			authSessionLogger.Debug("failed to update session activity", "area", "auth", "user_id", touch.UserID, "err", pkg.ErrText(err))
		}
	}
}
