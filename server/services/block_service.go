// Package services — BlockService: user blocking.
//
// Uses "blocked" status in the friendships table — no separate table.
// Block: delete existing friendship/request -> create "blocked" record.
// user_id = blocker, friend_id = target.
//
// Bidirectional enforcement: A->B block = mutual message block.
// IsBlocked checks both directions — used in DM send.
package services

import (
	"context"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"

	"github.com/google/uuid"
)

// BlockService handles user blocking operations.
type BlockService interface {
	BlockUser(ctx context.Context, blockerID, targetID string) error
	UnblockUser(ctx context.Context, blockerID, targetID string) error
	ListBlocked(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)
	// IsBlocked checks bidirectional block between two users. Also satisfies BlockChecker ISP.
	IsBlocked(ctx context.Context, userA, userB string) (bool, error)
}

// BlockChecker is a minimal ISP interface for block checks (used by dmService etc.).
type BlockChecker interface {
	IsBlocked(ctx context.Context, userA, userB string) (bool, error)
}

type blockService struct {
	friendRepo   repository.FriendshipStore
	userRepo     repository.UserRepository
	hub          ws.Broadcaster
	gameActivity GameActivityPrivacyInvalidator
}

func (s *blockService) reconcileActivityRelationship(ctx context.Context, userA, userB string) {
	if s.gameActivity != nil {
		s.gameActivity.RelationshipChanged(ctx, userA, userB)
	}
}

func NewBlockService(
	gameActivity GameActivityPrivacyInvalidator,
	friendRepo repository.FriendshipStore,
	userRepo repository.UserRepository,
	hub ws.Broadcaster,
) BlockService {
	return &blockService{
		gameActivity: gameActivity,
		friendRepo:   friendRepo,
		userRepo:     userRepo,
		hub:          hub,
	}
}

func (s *blockService) BlockUser(ctx context.Context, blockerID, targetID string) error {
	if blockerID == targetID {
		return fmt.Errorf("%w: cannot block yourself", pkg.ErrBadRequest)
	}

	if _, err := s.userRepo.GetByID(ctx, targetID); err != nil {
		return fmt.Errorf("%w: user not found", pkg.ErrNotFound)
	}
	now := time.Now().UTC()
	removed, err := s.friendRepo.CreateBlockAtomic(ctx, &models.Friendship{ID: uuid.New().String(), UserID: blockerID, FriendID: targetID, Status: models.FriendshipStatusBlocked, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		return err
	}
	// Publish only after the complete relationship transition commits.
	if removed {
		s.hub.BroadcastToUser(targetID, ws.Event{Op: ws.OpFriendRemove, Data: map[string]string{"user_id": blockerID}})
	}
	s.broadcastBlock(blockerID, targetID)
	s.reconcileActivityRelationship(ctx, blockerID, targetID)
	return nil
}

func (s *blockService) broadcastBlock(blockerID, targetID string) {
	// Notify both parties with the SAME payload: user_id is always the
	// blocker and blocked_user_id the target, so each client can tell which
	// side it is on instead of guessing from a single ambiguous user_id.
	blockEvent := ws.Event{
		Op: ws.OpUserBlock,
		Data: map[string]string{
			"user_id":         blockerID,
			"blocked_user_id": targetID,
		},
	}
	s.hub.BroadcastToUser(blockerID, blockEvent)
	s.hub.BroadcastToUser(targetID, blockEvent)

}

// UnblockUser removes a block. Only the blocker (user_id) can unblock.
func (s *blockService) UnblockUser(ctx context.Context, blockerID, targetID string) error {
	existing, err := s.friendRepo.GetByPair(ctx, blockerID, targetID)
	if err != nil {
		return err
	}

	if existing.Status != models.FriendshipStatusBlocked {
		return fmt.Errorf("%w: user is not blocked", pkg.ErrBadRequest)
	}

	if existing.UserID != blockerID {
		return fmt.Errorf("%w: you can only unblock users you blocked", pkg.ErrForbidden)
	}

	if err := s.friendRepo.Delete(ctx, existing.ID); err != nil {
		return err
	}

	s.hub.BroadcastToUser(blockerID, ws.Event{
		Op: ws.OpUserUnblock,
		Data: map[string]string{
			"user_id":           blockerID,
			"unblocked_user_id": targetID,
		},
	})
	s.reconcileActivityRelationship(ctx, blockerID, targetID)

	return nil
}

func (s *blockService) ListBlocked(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	blocked, err := s.friendRepo.ListBlocked(ctx, userID)
	if err != nil {
		return nil, err
	}

	if blocked == nil {
		blocked = []models.FriendshipWithUser{}
	}
	return blocked, nil
}

// IsBlocked checks bidirectional block — true if A->B or B->A "blocked" exists.
func (s *blockService) IsBlocked(ctx context.Context, userA, userB string) (bool, error) {
	return s.friendRepo.IsBlocked(ctx, userA, userB)
}
