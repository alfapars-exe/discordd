package services

import (
	"context"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"
)

type mediaLabelStore interface {
	Set(context.Context, *models.MediaLabel) error
	Get(context.Context, *models.MediaLabel) (*models.MediaLabel, error)
	Delete(context.Context, *models.MediaLabel) error
}
type recipientReferenceAccess interface {
	RecipientRevision(context.Context, string, string, string, string) (string, error)
}
type MediaLabelService struct {
	store  mediaLabelStore
	access recipientReferenceAccess
	hub    ws.Broadcaster
}

func (s *MediaLabelService) SetBroadcaster(hub ws.Broadcaster) { s.hub = hub }

// Invalidate only the owner's sessions. Clients re-read canonical state rather
// than applying potentially reordered label values from socket events.
func (s *MediaLabelService) changed(entry *models.MediaLabel) {
	if s.hub != nil {
		s.hub.BroadcastToUser(entry.UserID, ws.Event{Op: "media_label_changed", Data: map[string]string{
			"user_id": entry.UserID, "source_kind": entry.SourceKind, "channel_id": entry.ChannelID,
			"message_id": entry.MessageID, "revision": entry.Revision, "fingerprint": entry.Fingerprint,
		}})
	}
}

func NewMediaLabelService(store mediaLabelStore, access recipientReferenceAccess) *MediaLabelService {
	return &MediaLabelService{store: store, access: access}
}
func (s *MediaLabelService) reference(ctx context.Context, userID string, input *models.MediaLabel, write bool) (*models.MediaLabel, error) {
	if userID == "" {
		return nil, pkg.ErrUnauthorized
	}
	if err := input.Validate(write); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}
	revision, err := s.access.RecipientRevision(ctx, userID, input.SourceKind, input.ChannelID, input.MessageID)
	if err != nil {
		return nil, err
	}
	if revision != input.Revision {
		return nil, fmt.Errorf("%w: stale media reference", pkg.ErrConflict)
	}
	copy := *input
	copy.UserID = userID
	return &copy, nil
}
func (s *MediaLabelService) Set(ctx context.Context, userID string, input *models.MediaLabel) error {
	entry, err := s.reference(ctx, userID, input, true)
	if err != nil {
		return err
	}
	if err := s.store.Set(ctx, entry); err != nil {
		return err
	}
	s.changed(entry)
	return nil
}
func (s *MediaLabelService) Get(ctx context.Context, userID string, input *models.MediaLabel) (*models.MediaLabel, error) {
	entry, err := s.reference(ctx, userID, input, false)
	if err != nil {
		return nil, err
	}
	return s.store.Get(ctx, entry)
}

// Removing one's own annotation remains possible after source access is lost.
func (s *MediaLabelService) Delete(ctx context.Context, userID string, input *models.MediaLabel) error {
	if userID == "" {
		return pkg.ErrUnauthorized
	}
	if err := input.Validate(false); err != nil {
		return pkg.ErrBadRequest
	}
	copy := *input
	copy.UserID = userID
	if err := s.store.Delete(ctx, &copy); err != nil {
		return err
	}
	s.changed(&copy)
	return nil
}
