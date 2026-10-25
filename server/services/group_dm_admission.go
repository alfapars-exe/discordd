package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// Match the existing friends-only picker. This governs new admission only;
// it neither revokes existing memberships nor changes existing group sends.
func (s *groupDMService) requireGroupAdmissionFriend(ctx context.Context, actor, target string) error {
	if s.friendships == nil {
		return pkg.ErrForbidden
	}
	pair, err := s.friendships.GetByPair(ctx, actor, target)
	if errors.Is(err, pkg.ErrNotFound) {
		return pkg.ErrForbidden
	}
	if err != nil {
		return err
	}
	if pair == nil {
		return pkg.ErrForbidden
	}
	matches := (pair.UserID == actor && pair.FriendID == target) || (pair.UserID == target && pair.FriendID == actor)
	if pair.Status != models.FriendshipStatusAccepted || !matches {
		return pkg.ErrForbidden
	}
	return nil
}
