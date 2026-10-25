package services

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"github.com/google/uuid"
)

type ReminderService interface {
	Create(context.Context, string, *models.CreateMessageReminderRequest) (*models.MessageReminder, error)
	List(context.Context, string) ([]models.MessageReminder, error)
	Update(context.Context, string, string, string) (*models.MessageReminder, error)
	Cancel(context.Context, string, string) error
}

type MessageReminderWorker struct {
	repo   repository.ReminderRepository
	hub    ws.Broadcaster
	now    func() time.Time
	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
}

type reminderService struct {
	repo     repository.ReminderRepository
	messages repository.MessageRepository
	channels repository.ChannelRepository
	dms      repository.DMRepository
	perms    ChannelPermResolver
	now      func() time.Time
}

func NewReminderService(repo repository.ReminderRepository, messages repository.MessageRepository, channels repository.ChannelRepository, dms repository.DMRepository, perms ChannelPermResolver) ReminderService {
	return &reminderService{repo: repo, messages: messages, channels: channels, dms: dms, perms: perms, now: time.Now}
}
func NewMessageReminderWorker(repo repository.ReminderRepository, hub ws.Broadcaster) *MessageReminderWorker {
	return &MessageReminderWorker{repo: repo, hub: hub, now: time.Now}
}

func parseReminderDue(raw string, now time.Time) (time.Time, error) {
	due, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, fmt.Errorf("%w: due_at must be RFC3339", pkg.ErrBadRequest)
	}
	due = due.UTC()
	if !due.After(now.UTC()) {
		return time.Time{}, fmt.Errorf("%w: due_at must be in the future", pkg.ErrBadRequest)
	}
	if due.After(now.UTC().AddDate(1, 0, 0)) {
		return time.Time{}, fmt.Errorf("%w: due_at must be within one year", pkg.ErrBadRequest)
	}
	return due, nil
}
func (s *reminderService) Create(ctx context.Context, userID string, req *models.CreateMessageReminderRequest) (*models.MessageReminder, error) {
	if req == nil {
		return nil, fmt.Errorf("%w: reminder request required", pkg.ErrBadRequest)
	}
	stableID := ""
	if req.RequestID != "" {
		token, err := uuid.Parse(req.RequestID)
		if err != nil || len(req.RequestID) != 36 || token == uuid.Nil {
			return nil, fmt.Errorf("%w: request_id must be a nonzero UUID", pkg.ErrBadRequest)
		}
		stableID = uuid.NewSHA1(uuid.NameSpaceOID, []byte("hichat.reminder\x00"+userID+"\x00"+token.String())).String()
		stored, err := s.repo.GetByID(ctx, userID, stableID)
		if err == nil {
			if !reminderReplayMatches(stored, req) {
				return nil, fmt.Errorf("%w: reminder request identity reused with different data", pkg.ErrConflict)
			}
			return stored, nil
		}
		if !errors.Is(err, pkg.ErrNotFound) {
			return nil, err
		}
	}
	due, err := parseReminderDue(req.DueAt, s.now())
	if err != nil {
		return nil, err
	}
	if req.ChannelID == "" || req.MessageID == "" {
		return nil, fmt.Errorf("%w: channel_id and message_id are required", pkg.ErrBadRequest)
	}
	switch req.SourceKind {
	case models.ReminderSourceChannel:
		if req.ServerID == nil || *req.ServerID == "" {
			return nil, fmt.Errorf("%w: server_id is required", pkg.ErrBadRequest)
		}
		msg, e := s.messages.GetByID(ctx, req.MessageID)
		if e != nil || msg.ChannelID != req.ChannelID {
			return nil, fmt.Errorf("%w: message not found", pkg.ErrNotFound)
		}
		ch, e := s.channels.GetByID(ctx, req.ChannelID)
		if e != nil || ch.ServerID != *req.ServerID {
			return nil, fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
		}
		p, e := s.perms.ResolveChannelPermissions(ctx, userID, req.ChannelID)
		if e != nil {
			return nil, e
		}
		if !models.PermCanReadChannel(p) {
			return nil, fmt.Errorf("%w: missing read permission", pkg.ErrForbidden)
		}
	case models.ReminderSourceDM:
		if req.ServerID != nil {
			return nil, fmt.Errorf("%w: server_id is not valid for a DM", pkg.ErrBadRequest)
		}
		msg, e := s.dms.GetMessageByID(ctx, req.MessageID)
		if e != nil || msg.DMChannelID != req.ChannelID {
			return nil, fmt.Errorf("%w: message not found", pkg.ErrNotFound)
		}
		ch, e := s.dms.GetChannelByID(ctx, req.ChannelID)
		if e != nil {
			return nil, fmt.Errorf("%w: DM channel not found", pkg.ErrNotFound)
		}
		if ch.User1ID != userID && ch.User2ID != userID {
			return nil, fmt.Errorf("%w: not a DM member", pkg.ErrForbidden)
		}
	default:
		return nil, fmt.Errorf("%w: invalid source_kind", pkg.ErrBadRequest)
	}
	m := &models.MessageReminder{ID: stableID, UserID: userID, SourceKind: req.SourceKind, ServerID: req.ServerID, ChannelID: req.ChannelID, MessageID: req.MessageID, DueAt: reminderTimeService(due), Status: models.ReminderStatusScheduled}
	if err := s.repo.Create(ctx, m); err != nil {
		return nil, err
	}
	return m, nil
}
func reminderTimeService(t time.Time) string { return t.UTC().Format(time.RFC3339) }
func reminderReplayMatches(stored *models.MessageReminder, req *models.CreateMessageReminderRequest) bool {
	if stored == nil {
		return false
	}
	serverMatches := (stored.ServerID == nil && req.ServerID == nil) || (stored.ServerID != nil && req.ServerID != nil && *stored.ServerID == *req.ServerID)
	due, err := time.Parse(time.RFC3339, req.DueAt)
	if err != nil {
		return false
	}
	previous, err := time.Parse(time.RFC3339, stored.DueAt)
	return err == nil && serverMatches && stored.SourceKind == req.SourceKind && stored.ChannelID == req.ChannelID && stored.MessageID == req.MessageID && previous.Equal(due.UTC().Truncate(time.Second))
}
func (s *reminderService) List(ctx context.Context, userID string) ([]models.MessageReminder, error) {
	return s.repo.List(ctx, userID)
}
func (s *reminderService) Update(ctx context.Context, userID, id, dueRaw string) (*models.MessageReminder, error) {
	due, err := parseReminderDue(dueRaw, s.now())
	if err != nil {
		return nil, err
	}
	ok, err := s.repo.UpdateDue(ctx, userID, id, due)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%w: scheduled reminder not found", pkg.ErrNotFound)
	}
	return s.repo.GetByID(ctx, userID, id)
}
func (s *reminderService) Cancel(ctx context.Context, userID, id string) error {
	ok, err := s.repo.Cancel(ctx, userID, id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: scheduled reminder not found", pkg.ErrNotFound)
	}
	return nil
}

func (w *MessageReminderWorker) Start(ctx context.Context) func() {
	return w.start(ctx, 15*time.Second)
}
func (w *MessageReminderWorker) start(parent context.Context, interval time.Duration) func() {
	w.mu.Lock()
	if w.cancel != nil {
		c, d := w.cancel, w.done
		w.mu.Unlock()
		return func() { c(); <-d }
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	w.cancel = cancel
	w.done = done
	w.mu.Unlock()
	logx.Go("message_reminders", func() {
		defer func() { w.mu.Lock(); w.cancel = nil; close(done); w.mu.Unlock() }()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			w.runOnce(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
	return func() { cancel(); <-done }
}
func (w *MessageReminderWorker) runOnce(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	items, err := w.repo.DeliverDue(bounded, w.now(), 50)
	if err != nil {
		logx.Component("message_reminders").Warn("reminder delivery failed", "err", pkg.ErrText(err))
		return
	}
	for i := range items {
		broadcastNotificationCreate(w.hub, &items[i])
	}
}
