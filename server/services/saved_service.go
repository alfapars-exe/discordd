package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
)

var savedLogger = logx.Component("service.saved")

// SavedService is the per-user bookmark surface (saved_messages, migration
// 083). Saving is gated on the caller being able to read the message NOW
// (channel: ViewChannel + ReadMessages, override-aware; DM: membership) and
// listing re-checks channel permissions, so a bookmark never outlives the
// caller's access to what it points at.
type SavedService interface {
	// List returns the caller's bookmarks newest-first. Every raw row is
	// returned: one whose channel the caller can no longer read (or whose
	// permission resolve fails, or whose message is gone) comes back as the
	// unavailable stub so it can still be seen and deleted (not deleted —
	// access may return). has_more / next_before come from the raw rows.
	List(ctx context.Context, userID, beforeID string, limit int) (*models.SavedMessagePage, error)
	ListIDs(ctx context.Context, userID string) (*models.SavedMessageIDs, error)
	// Save bookmarks one message. created is false when the message was
	// already saved (the existing row is returned, nothing changes). Read
	// access is checked BEFORE any lookup, so every row Save returns is one
	// the caller can read right now. pkg.ErrNotFound when the message does
	// not exist, pkg.ErrForbidden when the caller cannot read it,
	// pkg.ErrBadRequest ("saved_limit_reached") past models.SavedMessagesLimit.
	Save(ctx context.Context, userID string, req *models.CreateSavedMessageRequest) (saved *models.SavedMessage, created bool, err error)
	// UpdateNote replaces the note (nil/empty clears it). pkg.ErrNotFound
	// covers both "no such row" and "not yours". The returned row passes the
	// same read re-check as List (stub when no longer readable).
	UpdateNote(ctx context.Context, userID, id string, note *string) (*models.SavedMessage, error)
	Delete(ctx context.Context, userID, id string) error
}

type savedService struct {
	savedRepo    repository.SavedRepository
	messageRepo  repository.MessageRepository
	channelRepo  repository.ChannelRepository
	dmRepo       repository.DMRepository
	permResolver ChannelPermResolver
}

func NewSavedService(
	savedRepo repository.SavedRepository,
	messageRepo repository.MessageRepository,
	channelRepo repository.ChannelRepository,
	dmRepo repository.DMRepository,
	permResolver ChannelPermResolver,
) SavedService {
	return &savedService{
		savedRepo:    savedRepo,
		messageRepo:  messageRepo,
		channelRepo:  channelRepo,
		dmRepo:       dmRepo,
		permResolver: permResolver,
	}
}

func (s *savedService) List(ctx context.Context, userID, beforeID string, limit int) (*models.SavedMessagePage, error) {
	if limit <= 0 {
		limit = models.SavedPageDefault
	}
	if limit > models.SavedPageMax {
		limit = models.SavedPageMax
	}

	// Fetch limit+1 to determine if more pages exist.
	list, err := s.savedRepo.List(ctx, userID, beforeID, limit+1)
	if err != nil {
		return nil, fmt.Errorf("failed to list saved messages: %w", err)
	}
	hasMore := len(list) > limit
	if hasMore {
		list = list[:limit]
	}

	// Cursor from the raw page, before any stubbing: the next page always
	// continues after the last row the repository returned, even when every
	// row on this page turned out unreadable.
	var nextBefore *string
	if hasMore && len(list) > 0 {
		id := list[len(list)-1].ID
		nextBefore = &id
	}

	readable := make(map[string]bool)
	for i := range list {
		s.applyReadCheck(ctx, userID, &list[i], readable)
	}

	return &models.SavedMessagePage{Saved: list, HasMore: hasMore, NextBefore: nextBefore}, nil
}

// applyReadCheck turns row into the unavailable stub when the caller can no
// longer read its channel message. Resolved once per distinct channel via
// cache (same gate as read_state_service.GetUnreadCounts); a resolve failure
// counts as "cannot read" — fail closed, the row stays visible as a stub.
// DM rows need no re-check: DM membership never changes for an existing
// channel, and a deleted channel takes its bookmarks with it. Rows already
// stubbed by the repository (dangling reference) are left as they are.
func (s *savedService) applyReadCheck(ctx context.Context, userID string, row *models.SavedMessage, cache map[string]bool) {
	if row.Message == nil {
		if row.DMMessage == nil {
			row.AsUnavailable()
		}
		return
	}
	channelID := row.Message.ChannelID
	ok, seen := cache[channelID]
	if !seen {
		perms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
		if err != nil {
			savedLogger.Warn("saved permission resolve failed, serving stub", "user_id", userID, "channel_id", channelID, "err", pkg.ErrText(err))
		}
		ok = err == nil && models.PermCanReadChannel(perms)
		cache[channelID] = ok
	}
	if !ok {
		row.AsUnavailable()
	}
}

func (s *savedService) ListIDs(ctx context.Context, userID string) (*models.SavedMessageIDs, error) {
	messageIDs, dmMessageIDs, err := s.savedRepo.ListIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list saved message ids: %w", err)
	}
	return &models.SavedMessageIDs{MessageIDs: messageIDs, DMMessageIDs: dmMessageIDs}, nil
}

func (s *savedService) Save(ctx context.Context, userID string, req *models.CreateSavedMessageRequest) (*models.SavedMessage, bool, error) {
	if (req.MessageID == "") == (req.DMMessageID == "") {
		return nil, false, fmt.Errorf("%w: exactly one of message_id or dm_message_id is required", pkg.ErrBadRequest)
	}
	note, err := normalizeOptionalNote(req.Note)
	if err != nil {
		return nil, false, err
	}

	if req.MessageID != "" {
		if err := s.authorizeChannelMessage(ctx, userID, req.MessageID); err != nil {
			return nil, false, err
		}
	} else {
		if err := s.authorizeDMMessage(ctx, userID, req.DMMessageID); err != nil {
			return nil, false, err
		}
	}

	// Idempotent: an existing bookmark is returned untouched (the note sent
	// with a repeat POST is ignored — PATCH is the way to change it).
	existing, err := s.savedRepo.FindByRef(ctx, userID, req.MessageID, req.DMMessageID)
	if err != nil {
		return nil, false, fmt.Errorf("failed to look up saved message: %w", err)
	}
	if existing != nil {
		return existing, false, nil
	}

	count, err := s.savedRepo.Count(ctx, userID)
	if err != nil {
		return nil, false, fmt.Errorf("failed to count saved messages: %w", err)
	}
	if count >= models.SavedMessagesLimit {
		return nil, false, fmt.Errorf("%w: saved_limit_reached", pkg.ErrBadRequest)
	}

	row := &models.SavedMessage{UserID: userID, Note: note}
	if req.MessageID != "" {
		id := req.MessageID
		row.MessageID = &id
	} else {
		id := req.DMMessageID
		row.DMMessageID = &id
	}
	if err := s.savedRepo.Create(ctx, row); err != nil {
		// Two concurrent saves of the same message race on the UNIQUE
		// constraint; the loser finds the winner's row and returns it, which
		// is exactly the idempotent answer a serial repeat would get.
		if again, findErr := s.savedRepo.FindByRef(ctx, userID, req.MessageID, req.DMMessageID); findErr == nil && again != nil {
			return again, false, nil
		}
		return nil, false, fmt.Errorf("failed to save message: %w", err)
	}

	saved, err := s.savedRepo.GetByID(ctx, userID, row.ID)
	if err != nil {
		return nil, false, fmt.Errorf("failed to load saved message: %w", err)
	}
	return saved, true, nil
}

func (s *savedService) UpdateNote(ctx context.Context, userID, id string, note *string) (*models.SavedMessage, error) {
	normalized, err := normalizeOptionalNote(note)
	if err != nil {
		return nil, err
	}
	ok, err := s.savedRepo.UpdateNote(ctx, userID, id, normalized)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%w: saved message not found", pkg.ErrNotFound)
	}
	row, err := s.savedRepo.GetByID(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	s.applyReadCheck(ctx, userID, row, make(map[string]bool))
	return row, nil
}

func (s *savedService) Delete(ctx context.Context, userID, id string) error {
	ok, err := s.savedRepo.Delete(ctx, userID, id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: saved message not found", pkg.ErrNotFound)
	}
	return nil
}

// authorizeChannelMessage — message exists (404), its channel exists (404),
// and the caller can read that channel (403). Same resolver + PermCanReadChannel
// gate as read_state_service.go.
func (s *savedService) authorizeChannelMessage(ctx context.Context, userID, messageID string) error {
	msg, err := s.messageRepo.GetByID(ctx, messageID)
	if err != nil {
		return fmt.Errorf("%w: message not found", pkg.ErrNotFound)
	}
	if _, err := s.channelRepo.GetByID(ctx, msg.ChannelID); err != nil {
		return fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
	}
	perms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, msg.ChannelID)
	if err != nil {
		return fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !models.PermCanReadChannel(perms) {
		return fmt.Errorf("%w: missing read messages permission for this channel", pkg.ErrForbidden)
	}
	return nil
}

// authorizeDMMessage — DM message exists (404) and the caller is a member
// of its channel (403).
func (s *savedService) authorizeDMMessage(ctx context.Context, userID, dmMessageID string) error {
	msg, err := s.dmRepo.GetMessageByID(ctx, dmMessageID)
	if err != nil {
		return fmt.Errorf("%w: DM message not found", pkg.ErrNotFound)
	}
	channel, err := s.dmRepo.GetChannelByID(ctx, msg.DMChannelID)
	if err != nil {
		return fmt.Errorf("%w: DM channel not found", pkg.ErrNotFound)
	}
	if channel.User1ID != userID && channel.User2ID != userID {
		return fmt.Errorf("%w: not a member of this DM channel", pkg.ErrForbidden)
	}
	return nil
}

// normalizeOptionalNote maps an absent/blank note to nil (stored NULL) and
// validates a present one through models.NormalizeNote.
func normalizeOptionalNote(note *string) (*string, error) {
	if note == nil {
		return nil, nil
	}
	normalized, err := models.NormalizeNote(*note)
	if err != nil {
		return nil, err
	}
	if normalized == "" {
		return nil, nil
	}
	return &normalized, nil
}
