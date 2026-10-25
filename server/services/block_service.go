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
	"errors"
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
	friendRepo   repository.FriendshipRepository
	userRepo     repository.UserRepository
	hub          ws.Broadcaster
	gameActivity GameActivityPrivacyInvalidator
}

func (s *blockService) SetGameActivityPrivacyInvalidator(invalidator GameActivityPrivacyInvalidator) {
	s.gameActivity = invalidator
}

func (s *blockService) reconcileActivityRelationship(ctx context.Context, userA, userB string) {
	if s.gameActivity != nil {
		s.gameActivity.RelationshipChanged(ctx, userA, userB)
	}
}

func NewBlockService(
	friendRepo repository.FriendshipRepository,
	userRepo repository.UserRepository,
	hub ws.Broadcaster,
) BlockService {
	return &blockService{
		friendRepo: friendRepo,
		userRepo:   userRepo,
		hub:        hub,
	}
}

func (s *blockService) BlockUser(ctx context.Context, blockerID, targetID string) error {
	if blockerID == targetID {
		return fmt.Errorf("%w: cannot block yourself", pkg.ErrBadRequest)
	}

	if _, err := s.userRepo.GetByID(ctx, targetID); err != nil {
		return fmt.Errorf("%w: user not found", pkg.ErrNotFound)
	}
	if writer, ok := s.friendRepo.(repository.AtomicBlockWriter); ok {
		now := time.Now().UTC()
		removed, err := writer.CreateBlockAtomic(ctx, &models.Friendship{ID: uuid.New().String(), UserID: blockerID, FriendID: targetID, Status: models.FriendshipStatusBlocked, CreatedAt: now, UpdatedAt: now})
		if err != nil {
			return err
		}
		// No relationship-removal or success event is emitted before commit.
		if removed {
			s.hub.BroadcastToUser(targetID, ws.Event{Op: ws.OpFriendRemove, Data: map[string]string{"user_id": blockerID}})
		}
		s.broadcastBlock(blockerID, targetID)
		s.reconcileActivityRelationship(ctx, blockerID, targetID)
		return nil
	}

	existing, err := s.friendRepo.GetByPair(ctx, blockerID, targetID)
	if err != nil && !errors.Is(err, pkg.ErrNotFound) {
		return err
	}

	if existing != nil {
		if existing.Status == models.FriendshipStatusBlocked {
			if existing.UserID == blockerID {
				return fmt.Errorf("%w: user already blocked", pkg.ErrAlreadyExists)
			}
			// A reverse block belongs to its owner. Keep it and add our own
			// directed row; unblocking ourselves must not remove their choice.
		} else {
			// pending or accepted — delete, then create blocked
			if err := s.friendRepo.Delete(ctx, existing.ID); err != nil {
				return err
			}
			s.reconcileActivityRelationship(ctx, blockerID, targetID)

			// Notify the other party about friendship removal
			otherID := existing.UserID
			if existing.UserID == blockerID {
				otherID = existing.FriendID
			}
			s.hub.BroadcastToUser(otherID, ws.Event{
				Op: ws.OpFriendRemove,
				Data: map[string]string{
					"user_id": blockerID,
				},
			})
		}
	}

	now := time.Now().UTC()
	blocked := &models.Friendship{
		ID:        uuid.New().String(),
		UserID:    blockerID,
		FriendID:  targetID,
		Status:    models.FriendshipStatusBlocked,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := s.friendRepo.Create(ctx, blocked); err != nil {
		return fmt.Errorf("failed to create block record: %w", err)
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
