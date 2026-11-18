package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// DMDeviceRosterAccess authorizes current device metadata for one conversation.
// It exposes no key bundles and does not consume one-time prekeys.
type DMDeviceRosterAccess interface {
	GetDeviceRosterMembers(context.Context, string, string) ([]string, error)
}

func (s *dmService) GetDeviceRosterMembers(ctx context.Context, userID, channelID string) ([]string, error) {
	channel, err := s.verifyChannelMembership(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}
	if channel.Status != models.DMStatusAccepted || !channel.E2EEEnabled {
		return nil, fmt.Errorf("%w: encrypted DM is not active", pkg.ErrForbidden)
	}
	other := channel.User1ID
	if other == userID {
		other = channel.User2ID
	}
	if other == userID {
		return []string{userID}, nil
	}
	actor, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if actor == nil {
		return nil, fmt.Errorf("%w: DM actor not found", pkg.ErrNotFound)
	}
	if actor.IsPlatformAdmin {
		return []string{channel.User1ID, channel.User2ID}, nil
	}
	if s.blockChecker != nil {
		blocked, err := s.blockChecker.IsBlocked(ctx, userID, other)
		if err != nil {
			return nil, fmt.Errorf("failed to check DM roster block status: %w", err)
		}
		if blocked {
			return nil, fmt.Errorf("%w: DM participant is blocked", pkg.ErrForbidden)
		}
	}
	friends := false
	if s.friendChecker != nil {
		friends, err = s.friendChecker.AreFriends(ctx, userID, other)
		if err != nil {
			return nil, fmt.Errorf("failed to check DM roster friendship: %w", err)
		}
	}
	recipient, err := s.userRepo.GetByID(ctx, other)
	if err != nil {
		return nil, err
	}
	if recipient == nil {
		return nil, fmt.Errorf("%w: DM recipient not found", pkg.ErrNotFound)
	}
	if recipient.DMPrivacy == "friends_only" && !friends {
		return nil, fmt.Errorf("%w: recipient only accepts friends", pkg.ErrForbidden)
	}
	if err := s.verifyDMRosterServerAccess(ctx, userID, other, channelID, friends); err != nil {
		return nil, err
	}
	return []string{channel.User1ID, channel.User2ID}, nil
}

// Match the send gate: opening an empty DM must not retain access after
// shared-server permissions change. Established history keeps send semantics.
func (s *dmService) verifyDMRosterServerAccess(ctx context.Context, userID, other, channelID string, friends bool) error {
	if s.serverDMPolicy == nil || friends {
		return nil
	}
	history, err := s.dmRepo.HasMessages(ctx, channelID)
	if err != nil {
		return fmt.Errorf("failed to check DM roster history: %w", err)
	}
	if history {
		return nil
	}
	allowed, err := s.serverDMPolicy.CanCreate(ctx, userID, other)
	if err != nil {
		return err
	}
	if !allowed {
		return fmt.Errorf("%w: shared-server DM permission denied", pkg.ErrForbidden)
	}
	return nil
}
