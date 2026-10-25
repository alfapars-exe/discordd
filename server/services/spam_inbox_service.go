package services

import (
	"context"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

type spamInboxStore interface {
	Record(context.Context, *models.SpamInboxEntry) error
	Decide(context.Context, string, string, string, string, string) (bool, error)
	List(context.Context, string, int) ([]models.SpamInboxEntry, error)
	Page(context.Context, string, string, int) (*models.SpamInboxPage, error)
	Decisions(context.Context, string, string, int) (*models.SpamInboxPage, error)
}

type SpamInboxService struct {
	store       spamInboxStore
	messages    repository.MessageRepository
	channels    repository.ChannelRepository
	dms         repository.DMRepository
	groups      repository.GroupDMRepository
	permissions ChannelPermResolver
	hub         ws.Broadcaster
}

func (s *SpamInboxService) SetBroadcaster(hub ws.Broadcaster) { s.hub = hub }

// RecipientRevision shares the existing read/access gate with recipient-private
// media annotations. It does not record spam, inspect plaintext or mutate state.
func (s *SpamInboxService) RecipientRevision(ctx context.Context, userID, kind, channelID, messageID string) (string, error) {
	if userID == "" {
		return "", pkg.ErrUnauthorized
	}
	return s.source(ctx, userID, &models.SpamInboxEntry{SourceKind: kind, ChannelID: channelID, MessageID: messageID})
}

func (s *SpamInboxService) Decisions(ctx context.Context, userID, cursor string, limit int) (*models.SpamInboxPage, error) {
	return s.store.Decisions(ctx, userID, cursor, limit)
}

func NewSpamInboxService(store spamInboxStore, messages repository.MessageRepository, channels repository.ChannelRepository, dms repository.DMRepository, groups repository.GroupDMRepository, permissions ChannelPermResolver) *SpamInboxService {
	return &SpamInboxService{store: store, messages: messages, channels: channels, dms: dms, groups: groups, permissions: permissions}
}

func (s *SpamInboxService) source(ctx context.Context, userID string, e *models.SpamInboxEntry) (string, error) {
	var edited *time.Time
	var author string
	switch e.SourceKind {
	case "channel":
		m, err := s.messages.GetByID(ctx, e.MessageID)
		if err != nil {
			return "", err
		}
		if m.ChannelID != e.ChannelID {
			return "", pkg.ErrNotFound
		}
		channel, err := s.channels.GetByID(ctx, e.ChannelID)
		if err != nil {
			return "", err
		}
		e.ServerID = channel.ServerID
		permissions, err := s.permissions.ResolveChannelPermissions(ctx, userID, e.ChannelID)
		if err != nil {
			return "", err
		}
		if !models.PermCanReadChannel(permissions) {
			return "", pkg.ErrForbidden
		}
		edited, author = m.EditedAt, m.UserID
	case "dm":
		m, err := s.dms.GetMessageByID(ctx, e.MessageID)
		if err != nil {
			return "", err
		}
		if m.DMChannelID != e.ChannelID {
			return "", pkg.ErrNotFound
		}
		channel, err := s.dms.GetChannelByID(ctx, e.ChannelID)
		if err != nil {
			return "", err
		}
		if channel.User1ID != userID && channel.User2ID != userID {
			return "", pkg.ErrNotFound
		}
		edited, author = m.EditedAt, m.UserID
	case "group":
		member, err := s.groups.IsMember(ctx, e.ChannelID, userID)
		if err != nil {
			return "", err
		}
		if !member {
			return "", pkg.ErrNotFound
		}
		m, err := s.groups.GetMessage(ctx, e.ChannelID, e.MessageID)
		if err != nil {
			return "", err
		}
		edited, author = m.EditedAt, m.UserID
	default:
		return "", fmt.Errorf("%w: invalid spam source", pkg.ErrBadRequest)
	}
	e.AuthorID = author
	if author == userID {
		return "", fmt.Errorf("%w: own message cannot be quarantined", pkg.ErrBadRequest)
	}
	if edited == nil {
		return "original", nil
	}
	return edited.UTC().Format(time.RFC3339Nano), nil
}

func (s *SpamInboxService) Record(ctx context.Context, userID string, entry *models.SpamInboxEntry) error {
	if err := entry.Validate(true); err != nil {
		return fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}
	revision, err := s.source(ctx, userID, entry)
	if err != nil {
		return err
	}
	if entry.Revision != revision {
		return fmt.Errorf("%w: stale message revision", pkg.ErrConflict)
	}
	safe := *entry
	safe.UserID = userID
	return s.store.Record(ctx, &safe)
}

func (s *SpamInboxService) Decide(ctx context.Context, userID string, entry *models.SpamInboxEntry, status string) error {
	if status != "restored" && status != "dismissed" {
		return pkg.ErrBadRequest
	}
	if err := entry.Validate(false); err != nil {
		return fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}
	// Removing one's own stale reference does not require source access.
	// Restoring visibility still rechecks the current source and revision.
	if status == "restored" {
		revision, err := s.source(ctx, userID, entry)
		if err != nil {
			return err
		}
		if entry.Revision != revision {
			return fmt.Errorf("%w: stale message revision", pkg.ErrConflict)
		}
	}
	changed, err := s.store.Decide(ctx, userID, entry.SourceKind, entry.MessageID, entry.Revision, status)
	if err != nil {
		return err
	}
	if !changed {
		return pkg.ErrNotFound
	}
	if s.hub != nil {
		s.hub.BroadcastToUser(userID, ws.Event{Op: "spam_decision", Data: map[string]string{"user_id": userID, "source_kind": entry.SourceKind, "message_id": entry.MessageID, "revision": entry.Revision, "status": status}})
	}
	return nil
}

func (s *SpamInboxService) List(ctx context.Context, userID string, limit int) ([]models.SpamInboxEntry, error) {
	entries, err := s.store.List(ctx, userID, limit)
	if err != nil {
		return nil, err
	}
	for i := range entries {
		revision, err := s.source(ctx, userID, &entries[i])
		entries[i].Unavailable = err != nil || revision != entries[i].Revision
	}
	return entries, nil
}

func (s *SpamInboxService) Page(ctx context.Context, userID, cursor string, limit int) (*models.SpamInboxPage, error) {
	page, err := s.store.Page(ctx, userID, cursor, limit)
	if err != nil {
		return nil, err
	}
	for i := range page.Entries {
		revision, err := s.source(ctx, userID, &page.Entries[i])
		page.Entries[i].Unavailable = err != nil || revision != page.Entries[i].Revision
	}
	return page, nil
}
