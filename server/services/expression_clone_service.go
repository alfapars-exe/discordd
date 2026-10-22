// Package services — expression_clone_service.go: copying a copyable emoji
// or sticker into another server (Karar D2-12..D2-14).
//
// The route gate has already checked PermManageExpressions in the TARGET
// server. This service adds: the caller must be a member of the SOURCE
// server (a non-member gets the same ErrExpressionNotFound as a missing id,
// so ids cannot be probed); the source must be in another server and
// copyable. The stored files are copied byte for byte — they are already
// our own encoder output, so nothing is decoded again — and the copy goes
// through the normal EmojiService / StickerService Create path (files, cap,
// UNIQUE name, cleanup on failure, broadcast) as a licence-locked clone.
package services

import (
	"context"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
)

var expressionCloneLogger = logx.Component("service.expression_clone")

// ExpressionCloneService copies emojis and stickers between servers.
type ExpressionCloneService interface {
	// CloneEmoji copies emoji req.SourceID into targetServerID for userID.
	CloneEmoji(ctx context.Context, targetServerID, userID string, req *models.CloneExpressionRequest) (*models.ServerEmoji, error)
	// CloneSticker copies sticker req.SourceID into targetServerID for userID.
	CloneSticker(ctx context.Context, targetServerID, userID string, req *models.CloneExpressionRequest) (*models.ServerSticker, error)
}

type expressionCloneService struct {
	emojiRepo   repository.EmojiRepository
	emojiSvc    EmojiService
	stickerRepo repository.StickerRepository
	stickerSvc  StickerService
	members     emojiMembershipChecker
	uploadDir   string
}

// NewExpressionCloneService builds the service. uploadDir is the root
// upload directory the source files are read from.
func NewExpressionCloneService(emojiRepo repository.EmojiRepository, emojiSvc EmojiService,
	stickerRepo repository.StickerRepository, stickerSvc StickerService,
	members emojiMembershipChecker, uploadDir string) ExpressionCloneService {
	return &expressionCloneService{
		emojiRepo: emojiRepo, emojiSvc: emojiSvc,
		stickerRepo: stickerRepo, stickerSvc: stickerSvc,
		members: members, uploadDir: uploadDir,
	}
}

// checkSource applies the shared gates in contract order: lookup error →
// membership → same server → copyable.
func (s *expressionCloneService) checkSource(ctx context.Context, lookupErr error, srcServerID, targetServerID, userID string, copyable bool) error {
	if errors.Is(lookupErr, pkg.ErrNotFound) {
		return models.ErrExpressionNotFound
	}
	if lookupErr != nil {
		return lookupErr
	}
	member, err := s.members.IsMember(ctx, srcServerID, userID)
	if err != nil {
		return fmt.Errorf("failed to check source server membership: %w", err)
	}
	if !member {
		return models.ErrExpressionNotFound
	}
	if srcServerID == targetServerID {
		return models.ErrExpressionCloneSameServer
	}
	if !copyable {
		return models.ErrExpressionNotCopyable
	}
	return nil
}

// readSourceFiles reads the static PNG and, for an animated source, the GIF.
// A row whose file is missing on disk is logged and reported as
// ErrExpressionNotFound.
func (s *expressionCloneService) readSourceFiles(sourceID, staticURL string, animated bool, animatedURL *string) (static, anim []byte, err error) {
	if s.uploadDir == "" {
		return nil, nil, fmt.Errorf("%w: upload directory not configured", pkg.ErrInternal)
	}
	defer func() {
		if errors.Is(err, models.ErrExpressionNotFound) {
			expressionCloneLogger.Warn("clone source file missing on disk", "source_id", sourceID)
		}
	}()
	static, err = readOwnExpressionFile(s.uploadDir, staticURL, expressionPNGMagic)
	if err != nil {
		return nil, nil, err
	}
	if !animated {
		return static, nil, nil
	}
	if animatedURL == nil {
		return nil, nil, models.ErrExpressionNotFound
	}
	anim, err = readOwnExpressionFile(s.uploadDir, *animatedURL, expressionGIFMagic)
	if err != nil {
		return nil, nil, err
	}
	return static, anim, nil
}

func cloneName(req *models.CloneExpressionRequest, srcName string) string {
	if req.Name != nil {
		return *req.Name
	}
	return srcName
}

func (s *expressionCloneService) CloneEmoji(ctx context.Context, targetServerID, userID string, req *models.CloneExpressionRequest) (*models.ServerEmoji, error) {
	src, err := s.emojiRepo.GetByID(ctx, req.SourceID)
	var srcServerID string
	copyable := false
	if err == nil {
		srcServerID, copyable = src.ServerID, src.Copyable && src.ClonedFrom == nil
	}
	if err := s.checkSource(ctx, err, srcServerID, targetServerID, userID, copyable); err != nil {
		return nil, err
	}

	create := &models.CreateEmojiRequest{
		Name:        cloneName(req, src.Name),
		DisplayName: src.DisplayName,
		Copyable:    false,
		ClonedFrom:  src.ID,
	}
	if err := create.Validate(); err != nil {
		return nil, err
	}
	if err := s.emojiSvc.PrecheckCreate(ctx, targetServerID, create); err != nil {
		return nil, err
	}
	static, anim, err := s.readSourceFiles(src.ID, src.URL, src.Animated, src.AnimatedURL)
	if err != nil {
		return nil, err
	}
	return s.emojiSvc.Create(ctx, targetServerID, userID, create, static, anim)
}

func (s *expressionCloneService) CloneSticker(ctx context.Context, targetServerID, userID string, req *models.CloneExpressionRequest) (*models.ServerSticker, error) {
	src, err := s.stickerRepo.GetByID(ctx, req.SourceID)
	var srcServerID string
	copyable := false
	if err == nil {
		srcServerID, copyable = src.ServerID, src.Copyable && src.ClonedFrom == nil
	}
	if err := s.checkSource(ctx, err, srcServerID, targetServerID, userID, copyable); err != nil {
		return nil, err
	}

	create := &models.CreateStickerRequest{
		Name:        cloneName(req, src.Name),
		DisplayName: src.DisplayName,
		Description: src.Description,
		Tags:        src.Tags,
		Copyable:    false,
		ClonedFrom:  src.ID,
	}
	if err := create.Validate(); err != nil {
		return nil, err
	}
	if err := s.stickerSvc.PrecheckCreate(ctx, targetServerID, create); err != nil {
		return nil, err
	}
	static, anim, err := s.readSourceFiles(src.ID, src.URL, src.Animated, src.AnimatedURL)
	if err != nil {
		return nil, err
	}
	return s.stickerSvc.Create(ctx, targetServerID, userID, create, static, anim)
}
