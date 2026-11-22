package main

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
)

const (
	voiceActivityQueueSize = 256
	voiceActivityBudget    = 5 * time.Second
)

type voiceActivityUpdate struct{ userID, channelID string }

// Activity timestamps are best-effort bookkeeping. Keep their database work
// out of the Hub's ordered voice callbacks so a slow write cannot stall the
// same user's next join, leave or moderation action.
type voiceActivityWriter struct {
	mu       sync.Mutex
	stopped  bool
	queue    chan voiceActivityUpdate
	cancel   context.CancelFunc
	done     chan struct{}
	stopOnce sync.Once
	dropped  atomic.Uint64
}

func newVoiceActivityWriter(write func(context.Context, voiceActivityUpdate)) *voiceActivityWriter {
	ctx, cancel := context.WithCancel(context.Background())
	w := &voiceActivityWriter{
		queue:  make(chan voiceActivityUpdate, voiceActivityQueueSize),
		cancel: cancel, done: make(chan struct{}),
	}
	logx.Go("voice-activity-writer", func() {
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
			case update, ok := <-w.queue:
				if !ok {
					return
				}
				if ctx.Err() != nil {
					w.dropped.Add(uint64(len(w.queue) + 1))
					return
				}
				logx.Run("voice-activity-update", func() {
					workCtx, workCancel := context.WithTimeout(ctx, voiceActivityBudget)
					defer workCancel()
					write(workCtx, update)
				})
			}
		}
	})
	return w
}

func (w *voiceActivityWriter) enqueue(userID, channelID string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return false
	}
	select {
	case w.queue <- voiceActivityUpdate{userID: userID, channelID: channelID}:
		return true
	default:
		w.dropped.Add(1)
		return false
	}
}

func (w *voiceActivityWriter) reportDropped() {
	if count := w.dropped.Swap(0); count > 0 {
		hubLogger.Warn("voice activity updates dropped", "area", "voice", "count", count)
	}
}

// Stop closes admission and drains for one bounded budget. On timeout, cancel
// the in-flight database operation and discard remaining timestamp updates.
// Waiting for done guarantees the database can close safely afterwards.
func (w *voiceActivityWriter) stop() {
	w.stopOnce.Do(func() {
		w.mu.Lock()
		w.stopped = true
		close(w.queue)
		w.mu.Unlock()
		timer := time.NewTimer(voiceActivityBudget)
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

func voiceActivityWrite(userRepo repository.UserRepository, channelRepo repository.ChannelRepository, serverRepo repository.ServerRepository) func(context.Context, voiceActivityUpdate) {
	return func(ctx context.Context, update voiceActivityUpdate) {
		if err := userRepo.UpdateLastVoiceActivity(ctx, update.userID); err != nil {
			hubLogger.Error("failed to update user voice activity", "area", "voice", "user_id", update.userID, "err", pkg.ErrText(err))
		}
		if ctx.Err() != nil {
			return
		}
		ch, err := channelRepo.GetByID(ctx, update.channelID)
		if err != nil {
			hubLogger.Error("channel lookup for activity tracking failed", "area", "voice", "channel_id", update.channelID, "err", pkg.ErrText(err))
			return
		}
		if ctx.Err() != nil {
			return
		}
		if err := serverRepo.UpdateLastVoiceActivity(ctx, ch.ServerID); err != nil {
			hubLogger.Error("failed to update server voice activity", "area", "voice", "server_id", ch.ServerID, "err", pkg.ErrText(err))
		}
	}
}
