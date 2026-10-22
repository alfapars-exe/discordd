// Package services — sticker_service.go: per-server stickers (migration
// 087). Mirror of emoji_service.go: the handler runs the image pipeline;
// this service owns the files on disk, the per-server cap, the
// copyable-licence rule and the WS broadcasts.
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

// stickerSubdir is the upload subdirectory sticker files live in; their
// URLs are "/api/uploads/stickers/{id}.png" (+ ".gif" for animated ones).
const stickerSubdir = "stickers"

// StickerService manages server stickers.
type StickerService interface {
	// List returns serverID's stickers (the route gate has checked membership).
	List(ctx context.Context, serverID string) ([]models.ServerSticker, error)
	// ListMine returns the stickers of every server userID is a member of.
	ListMine(ctx context.Context, userID string) ([]models.ServerSticker, error)
	// PrecheckCreate rejects, before any image work, a validated request
	// whose name is taken (ErrExpressionNameTaken) or a server at its cap
	// (ErrExpressionLimitReached). Create re-checks both atomically.
	PrecheckCreate(ctx context.Context, serverID string, req *models.CreateStickerRequest) error
	// Create stores the pipeline output (static PNG, optional animated GIF)
	// and inserts the row within models.MaxStickersPerServer. Files are
	// removed again if the insert fails. A non-empty req.ClonedFrom stores
	// a clone: ClonedFrom set, Copyable forced false. Broadcasts
	// server_sticker_create.
	Create(ctx context.Context, serverID, userID string, req *models.CreateStickerRequest, static, animated []byte) (*models.ServerSticker, error)
	// Update applies a validated PATCH to stickerID of serverID (another
	// server's id is pkg.ErrNotFound). A clone's copyable never changes
	// (ErrExpressionLicenseLocked). Otherwise changing copyable is the
	// creator's call alone (ErrExpressionLicenseCreatorOnly); with the
	// creator's account gone, it may only be switched off. Broadcasts
	// server_sticker_update.
	Update(ctx context.Context, serverID, stickerID, userID string, req *models.UpdateStickerRequest) (*models.ServerSticker, error)
	// Delete removes the row, then its files, then broadcasts
	// server_sticker_delete.
	Delete(ctx context.Context, serverID, stickerID string) error
}

type stickerService struct {
	repo      repository.StickerRepository
	hub       ws.Broadcaster
	uploadDir string
}

// NewStickerService builds the service. uploadDir is the root upload
// directory; sticker files go to its stickers/ subdirectory. Unlike
// NewEmojiService it takes no membership checker: stickers are never
// reactions, and the clone service checks membership itself.
func NewStickerService(repo repository.StickerRepository, hub ws.Broadcaster, uploadDir string) StickerService {
	return &stickerService{repo: repo, hub: hub, uploadDir: uploadDir}
}

func (s *stickerService) List(ctx context.Context, serverID string) ([]models.ServerSticker, error) {
	return s.repo.ListByServer(ctx, serverID)
}

func (s *stickerService) ListMine(ctx context.Context, userID string) ([]models.ServerSticker, error) {
	return s.repo.ListForUser(ctx, userID)
}

func (s *stickerService) PrecheckCreate(ctx context.Context, serverID string, req *models.CreateStickerRequest) error {
	existing, err := s.repo.ListByServer(ctx, serverID)
	if err != nil {
		return err
	}
	if len(existing) >= models.MaxStickersPerServer {
		return models.ErrExpressionLimitReached
	}
	if slices.ContainsFunc(existing, func(st models.ServerSticker) bool { return st.Name == req.Name }) {
		return models.ErrExpressionNameTaken
	}
	return nil
}

func (s *stickerService) Create(ctx context.Context, serverID, userID string, req *models.CreateStickerRequest, static, animated []byte) (*models.ServerSticker, error) {
	if s.uploadDir == "" {
		return nil, fmt.Errorf("%w: sticker upload directory not configured", pkg.ErrInternal)
	}
	if len(static) == 0 {
		return nil, fmt.Errorf("%w: static sticker image missing", pkg.ErrInternal)
	}
	idBytes := make([]byte, 8)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, fmt.Errorf("failed to generate sticker id: %w", err)
	}
	id := hex.EncodeToString(idBytes)

	dir := filepath.Join(s.uploadDir, stickerSubdir)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("failed to create sticker directory: %w", err)
	}

	tags := req.Tags
	if tags == nil {
		tags = []string{}
	}
	creator := userID
	st := &models.ServerSticker{
		ID:          id,
		ServerID:    serverID,
		Name:        req.Name,
		DisplayName: req.DisplayName,
		Description: req.Description,
		Tags:        tags,
		Animated:    animated != nil,
		Copyable:    req.Copyable,
		CreatedBy:   &creator,
	}
	if req.ClonedFrom != "" {
		clonedFrom := req.ClonedFrom
		st.ClonedFrom = &clonedFrom
		st.Copyable = false
	}

	var written []string
	cleanup := func() { removeUploadFilesByURL(s.uploadDir, written) }

	staticURL, err := publishExpressionFile(dir, stickerSubdir, id+".png", static)
	if err != nil {
		return nil, err
	}
	written = append(written, staticURL)
	st.URL = staticURL

	if animated != nil {
		animatedURL, err := publishExpressionFile(dir, stickerSubdir, id+".gif", animated)
		if err != nil {
			cleanup()
			return nil, err
		}
		written = append(written, animatedURL)
		st.AnimatedURL = &animatedURL
	}

	if err := s.repo.CreateWithCap(ctx, st, models.MaxStickersPerServer); err != nil {
		cleanup()
		if errors.Is(err, pkg.ErrAlreadyExists) {
			return nil, models.ErrExpressionNameTaken
		}
		return nil, err
	}

	s.hub.BroadcastToServer(serverID, ws.Event{Op: ws.OpServerStickerCreate, Data: *st})
	return st, nil
}

func (s *stickerService) Update(ctx context.Context, serverID, stickerID, userID string, req *models.UpdateStickerRequest) (*models.ServerSticker, error) {
	st, err := s.repo.GetInServer(ctx, serverID, stickerID)
	if err != nil {
		return nil, err
	}

	if req.Copyable != nil && *req.Copyable != st.Copyable {
		// Licence lock first: the cloner is the clone's creator.
		if st.ClonedFrom != nil {
			return nil, models.ErrExpressionLicenseLocked
		}
		isCreator := st.CreatedBy != nil && *st.CreatedBy == userID
		orphanSwitchOff := st.CreatedBy == nil && !*req.Copyable
		if !isCreator && !orphanSwitchOff {
			return nil, models.ErrExpressionLicenseCreatorOnly
		}
		st.Copyable = *req.Copyable
	}
	if req.Name != nil {
		st.Name = *req.Name
	}
	if req.DisplayName != nil {
		st.DisplayName = *req.DisplayName
	}
	if req.Description != nil {
		st.Description = *req.Description
	}
	if req.Tags != nil {
		st.Tags = *req.Tags
	}

	if err := s.repo.Update(ctx, st); err != nil {
		if errors.Is(err, pkg.ErrAlreadyExists) {
			return nil, models.ErrExpressionNameTaken
		}
		return nil, err
	}

	s.hub.BroadcastToServer(serverID, ws.Event{Op: ws.OpServerStickerUpdate, Data: *st})
	return st, nil
}

func (s *stickerService) Delete(ctx context.Context, serverID, stickerID string) error {
	st, err := s.repo.GetInServer(ctx, serverID, stickerID)
	if err != nil {
		return err
	}
	if err := s.repo.Delete(ctx, serverID, stickerID); err != nil {
		return err
	}

	// Files only after the row is gone (removeUploadFilesByURL's contract).
	// Once the row is gone IsPublicAsset no longer matches, so a file that
	// fails to delete is unreachable, not exposed.
	urls := []string{st.URL}
	if st.AnimatedURL != nil {
		urls = append(urls, *st.AnimatedURL)
	}
	removeUploadFilesByURL(s.uploadDir, urls)

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerStickerDelete,
		Data: map[string]string{"id": stickerID, "server_id": serverID},
	})
	return nil
}
