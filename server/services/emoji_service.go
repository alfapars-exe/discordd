// Package services — emoji_service.go: per-server custom emojis
// (migration 086). The handler runs the image pipeline; this service owns
// the files on disk, the per-type caps, the copyable-licence rule and the
// WS broadcasts.
package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

// emojiSubdir is the upload subdirectory emoji files live in; their URLs
// are "/api/uploads/emojis/{id}.png" (+ ".gif" for animated emojis).
const emojiSubdir = "emojis"

// EmojiService manages server custom emojis.
type EmojiService interface {
	// List returns serverID's emojis (the route gate has checked membership).
	List(ctx context.Context, serverID string) ([]models.ServerEmoji, error)
	// ListMine returns the emojis of every server userID is a member of.
	ListMine(ctx context.Context, userID string) ([]models.ServerEmoji, error)
	// PrecheckCreate rejects, before any image work, a validated request
	// whose name is taken (ErrExpressionNameTaken) or a server whose static
	// AND animated caps are both full (ErrExpressionLimitReached). Create
	// re-checks both atomically.
	PrecheckCreate(ctx context.Context, serverID string, req *models.CreateEmojiRequest) error
	// Create stores the pipeline output (static PNG, optional animated GIF)
	// and inserts the row within the per-type cap. Files are removed again
	// if the insert fails. A non-empty req.ClonedFrom stores a clone:
	// ClonedFrom set, Copyable forced false. Broadcasts server_emoji_create.
	Create(ctx context.Context, serverID, userID string, req *models.CreateEmojiRequest, static, animated []byte) (*models.ServerEmoji, error)
	// Update applies a validated PATCH to emojiID of serverID (another
	// server's id is pkg.ErrNotFound). A clone's copyable never changes
	// (ErrExpressionLicenseLocked). Otherwise changing copyable is the
	// creator's call alone (ErrExpressionLicenseCreatorOnly); with the
	// creator's account gone, it may only be switched off. Broadcasts
	// server_emoji_update.
	Update(ctx context.Context, serverID, emojiID, userID string, req *models.UpdateEmojiRequest) (*models.ServerEmoji, error)
	// Delete removes the row, then its files, then broadcasts
	// server_emoji_delete.
	Delete(ctx context.Context, serverID, emojiID string) error
	EmojiResolver
}

// emojiMembershipChecker is the slice of ServerRepository the service needs.
type emojiMembershipChecker interface {
	IsMember(ctx context.Context, serverID, userID string) (bool, error)
}

type emojiService struct {
	repo      repository.EmojiRepository
	members   emojiMembershipChecker
	hub       ws.Broadcaster
	uploadDir string
}

// NewEmojiService builds the service. uploadDir is the root upload
// directory; emoji files go to its emojis/ subdirectory.
func NewEmojiService(repo repository.EmojiRepository, members emojiMembershipChecker, hub ws.Broadcaster, uploadDir string) EmojiService {
	return &emojiService{repo: repo, members: members, hub: hub, uploadDir: uploadDir}
}

func (s *emojiService) List(ctx context.Context, serverID string) ([]models.ServerEmoji, error) {
	return s.repo.ListByServer(ctx, serverID)
}

func (s *emojiService) ListMine(ctx context.Context, userID string) ([]models.ServerEmoji, error) {
	return s.repo.ListForUser(ctx, userID)
}

func (s *emojiService) PrecheckCreate(ctx context.Context, serverID string, req *models.CreateEmojiRequest) error {
	static, animated, err := s.repo.CountByServer(ctx, serverID)
	if err != nil {
		return err
	}
	if static >= models.MaxStaticEmojisPerServer && animated >= models.MaxAnimatedEmojisPerServer {
		return models.ErrExpressionLimitReached
	}
	existing, err := s.repo.ListByServer(ctx, serverID)
	if err != nil {
		return err
	}
	if slices.ContainsFunc(existing, func(e models.ServerEmoji) bool { return e.Name == req.Name }) {
		return models.ErrExpressionNameTaken
	}
	return nil
}

func (s *emojiService) Create(ctx context.Context, serverID, userID string, req *models.CreateEmojiRequest, static, animated []byte) (*models.ServerEmoji, error) {
	if s.uploadDir == "" {
		return nil, fmt.Errorf("%w: emoji upload directory not configured", pkg.ErrInternal)
	}
	if len(static) == 0 {
		return nil, fmt.Errorf("%w: static emoji image missing", pkg.ErrInternal)
	}
	idBytes := make([]byte, 8)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, fmt.Errorf("failed to generate emoji id: %w", err)
	}
	id := hex.EncodeToString(idBytes)

	dir := filepath.Join(s.uploadDir, emojiSubdir)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("failed to create emoji directory: %w", err)
	}

	creator := userID
	e := &models.ServerEmoji{
		ID:          id,
		ServerID:    serverID,
		Name:        req.Name,
		DisplayName: req.DisplayName,
		Animated:    animated != nil,
		Copyable:    req.Copyable,
		CreatedBy:   &creator,
	}
	if req.ClonedFrom != "" {
		clonedFrom := req.ClonedFrom
		e.ClonedFrom = &clonedFrom
		e.Copyable = false
	}

	var written []string
	cleanup := func() { removeUploadFilesByURL(s.uploadDir, written) }

	staticURL, err := publishExpressionFile(dir, emojiSubdir, id+".png", static)
	if err != nil {
		return nil, err
	}
	written = append(written, staticURL)
	e.URL = staticURL

	maxForType := models.MaxStaticEmojisPerServer
	if animated != nil {
		animatedURL, err := publishExpressionFile(dir, emojiSubdir, id+".gif", animated)
		if err != nil {
			cleanup()
			return nil, err
		}
		written = append(written, animatedURL)
		e.AnimatedURL = &animatedURL
		maxForType = models.MaxAnimatedEmojisPerServer
	}

	if err := s.repo.CreateWithCap(ctx, e, maxForType); err != nil {
		cleanup()
		if errors.Is(err, pkg.ErrAlreadyExists) {
			return nil, models.ErrExpressionNameTaken
		}
		return nil, err
	}

	s.hub.BroadcastToServer(serverID, ws.Event{Op: ws.OpServerEmojiCreate, Data: *e})
	return e, nil
}

func (s *emojiService) Update(ctx context.Context, serverID, emojiID, userID string, req *models.UpdateEmojiRequest) (*models.ServerEmoji, error) {
	e, err := s.repo.GetInServer(ctx, serverID, emojiID)
	if err != nil {
		return nil, err
	}

	if req.Copyable != nil && *req.Copyable != e.Copyable {
		// A clone's licence is locked (always false), checked before the
		// creator rule: the cloner is the clone's creator.
		if e.ClonedFrom != nil {
			return nil, models.ErrExpressionLicenseLocked
		}
		isCreator := e.CreatedBy != nil && *e.CreatedBy == userID
		orphanSwitchOff := e.CreatedBy == nil && !*req.Copyable
		if !isCreator && !orphanSwitchOff {
			return nil, models.ErrExpressionLicenseCreatorOnly
		}
		e.Copyable = *req.Copyable
	}
	if req.Name != nil {
		e.Name = *req.Name
	}
	if req.DisplayName != nil {
		e.DisplayName = *req.DisplayName
	}

	if err := s.repo.Update(ctx, e); err != nil {
		if errors.Is(err, pkg.ErrAlreadyExists) {
			return nil, models.ErrExpressionNameTaken
		}
		return nil, err
	}

	s.hub.BroadcastToServer(serverID, ws.Event{Op: ws.OpServerEmojiUpdate, Data: *e})
	return e, nil
}

func (s *emojiService) Delete(ctx context.Context, serverID, emojiID string) error {
	e, err := s.repo.GetInServer(ctx, serverID, emojiID)
	if err != nil {
		return err
	}
	if err := s.repo.Delete(ctx, serverID, emojiID); err != nil {
		return err
	}

	// Files only after the row is gone (removeUploadFilesByURL's contract).
	// Once the row is gone IsPublicAsset no longer matches, so a file that
	// fails to delete is unreachable, not exposed.
	urls := []string{e.URL}
	if e.AnimatedURL != nil {
		urls = append(urls, *e.AnimatedURL)
	}
	removeUploadFilesByURL(s.uploadDir, urls)

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerEmojiDelete,
		Data: map[string]string{"id": emojiID, "server_id": serverID},
	})
	return nil
}

func (s *emojiService) ResolveForReaction(ctx context.Context, userID, emojiID string, animated bool) error {
	e, err := s.repo.GetByID(ctx, emojiID)
	if errors.Is(err, pkg.ErrNotFound) {
		return models.ErrUnknownEmoji
	}
	if err != nil {
		return err
	}
	if e.Animated != animated {
		return models.ErrUnknownEmoji
	}
	member, err := s.members.IsMember(ctx, e.ServerID, userID)
	if err != nil {
		return fmt.Errorf("failed to check emoji server membership: %w", err)
	}
	if !member {
		return models.ErrUnknownEmoji
	}
	return nil
}
