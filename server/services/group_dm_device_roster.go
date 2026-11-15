package services

import (
	"context"
	"fmt"
	"github.com/argeinfina/hichat/pkg"
	"slices"
)

// GroupDMDeviceRosterAccess returns fresh group membership and its encryption epoch.
type GroupDMDeviceRosterAccess interface {
	GetGroupDeviceRosterMembers(context.Context, string, string) (int64, []string, error)
}

func (s *groupDMService) GetGroupDeviceRosterMembers(ctx context.Context, userID, groupID string) (int64, []string, error) {
	before, err := s.requireMember(ctx, groupID, userID)
	if err != nil {
		return 0, nil, err
	}
	ids, err := s.groups.ListMemberIDs(ctx, groupID)
	if err != nil {
		return 0, nil, err
	}
	// Membership changes rotate the epoch. Reject a mixed snapshot rather than
	// returning old members under a new epoch. The message commit fences it again.
	after, err := s.requireMember(ctx, groupID, userID)
	if err != nil {
		return 0, nil, err
	}
	if before == nil || after == nil || before.KeyEpoch != after.KeyEpoch {
		return 0, nil, fmt.Errorf("%w: group encryption key changed", pkg.ErrConflict)
	}
	if !slices.Contains(ids, userID) {
		return 0, nil, pkg.ErrNotFound
	}
	return after.KeyEpoch, ids, nil
}
