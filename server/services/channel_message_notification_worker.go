package services

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var channelMessageNotificationLogger = logx.Component("service.channel_message_notification")

type channelNotificationPreferences struct {
	Notifications struct {
		ChannelMessageNotifications bool `json:"channelMessageNotifications"`
	} `json:"notifications"`
	Privacy struct {
		IgnoredUsers map[string]bool `json:"ignoredUsers"`
	} `json:"privacy"`
}

type ChannelMessageNotificationWorker struct {
	durablePublication bool
	queue              repository.ChannelMessageNotificationQueue
	prefs              repository.PreferencesRepository
	users              repository.UserRepository
	hub                ws.Broadcaster
}

// PostgreSQL publication is recorded by the notification INSERT trigger in the
// same transaction as CommitBatch; only legacy fixtures use direct fan-out.
func (w *ChannelMessageNotificationWorker) SetDurablePublication(enabled bool) {
	w.durablePublication = enabled
}

func NewChannelMessageNotificationWorker(queue repository.ChannelMessageNotificationQueue, prefs repository.PreferencesRepository,
	users repository.UserRepository, hub ws.Broadcaster) *ChannelMessageNotificationWorker {
	return &ChannelMessageNotificationWorker{queue: queue, prefs: prefs, users: users, hub: hub}
}

// ProcessNextBatch performs at most one bounded page. Cursor advancement and
// inserts are atomic in the repository; next page is selected fairly by the
// number of completed pages so a large server cannot monopolize the worker.
func (w *ChannelMessageNotificationWorker) ProcessNextBatch(ctx context.Context) (bool, error) {
	job, ids, err := w.queue.NextBatch(ctx, repository.ChannelMessageNotificationBatchSize)
	if err != nil {
		return false, err
	}
	if job == nil {
		return false, nil
	}
	next := job.CursorUserID
	if len(ids) > 0 {
		next = ids[len(ids)-1]
	}
	done := len(ids) < repository.ChannelMessageNotificationBatchSize
	eligible := make([]*models.Notification, 0, len(ids))
	if len(ids) > 0 {
		reader, ok := w.prefs.(repository.PreferencesBatchReader)
		if !ok {
			return false, w.failBatch(ctx, job, fmt.Errorf("preferences repository lacks bounded batch reads"))
		}
		preferences, err := reader.GetMany(ctx, ids)
		if err != nil {
			return false, w.failBatch(ctx, job, fmt.Errorf("read channel notification preferences: %w", err))
		}
		suppressed, err := w.queue.SuppressedRecipients(ctx, job, ids)
		if err != nil {
			return false, w.failBatch(ctx, job, fmt.Errorf("read channel notification suppression state: %w", err))
		}
		for _, id := range ids {
			p := preferences[id]
			if p == nil {
				continue
			} // Missing preference rows are opt-out by default.
			var data channelNotificationPreferences
			if json.Unmarshal(p.Data, &data) != nil || !data.Notifications.ChannelMessageNotifications || data.Privacy.IgnoredUsers[job.ActorID] {
				continue
			}
			if suppressed[id] {
				continue
			}
			eligible = append(eligible, &models.Notification{UserID: id})
		}
	}
	created, committed, err := w.queue.CommitBatch(ctx, job, next, done, eligible)
	if err != nil {
		return false, w.failBatch(ctx, job, err)
	}
	if !committed {
		return true, nil
	}
	if w.durablePublication {
		return true, nil
	}
	if len(created) > 0 {
		actor, actorErr := w.users.GetByID(ctx, job.ActorID)
		if actorErr != nil {
			channelMessageNotificationLogger.Warn("channel notification actor lookup failed", "actor_id", job.ActorID, "err", pkg.ErrText(actorErr))
		}
		for _, n := range created {
			if actorErr == nil {
				n.Actor = models.ToPublicUser(actor)
			}
			broadcastNotificationCreate(w.hub, n)
		}
	}
	return true, nil
}

func (w *ChannelMessageNotificationWorker) failBatch(ctx context.Context, job *repository.ChannelMessageNotificationJob, cause error) error {
	if err := w.queue.FailBatch(ctx, job); err != nil {
		return fmt.Errorf("%w (also failed to schedule retry: %v)", cause, err)
	}
	return cause
}

func (w *ChannelMessageNotificationWorker) Start(ctx context.Context) func() {
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-workerCtx.Done():
				return
			case <-ticker.C:
				workCtx, workCancel := context.WithTimeout(workerCtx, 15*time.Second)
				if _, err := w.ProcessNextBatch(workCtx); err != nil {
					channelMessageNotificationLogger.Error("channel notification batch failed", "err", pkg.ErrText(err))
				}
				workCancel()
			}
		}
	}()
	return func() { cancel(); <-done }
}
