package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
)

// CosmeticEntitlements decides whether a user may wear a catalog item.
//
// HiChat runs cosmetics in 'everyone' instance mode: no shop, no SKU, no
// premium tier. This interface is the single seam a future paid tier would
// change.
type CosmeticEntitlements interface {
	CanWear(ctx context.Context, userID string, item *models.CosmeticItem) (bool, error)
}

// CosmeticGrantChecker reports grants (repository.CosmeticRepository).
type CosmeticGrantChecker interface {
	HasGrant(ctx context.Context, userID, itemID string) (bool, error)
}

// CosmeticMemberChecker reports server membership (repository.ServerRepository).
type CosmeticMemberChecker interface {
	IsMember(ctx context.Context, serverID, userID string) (bool, error)
}

// everyoneEntitlements is the only CosmeticEntitlements: every built-in
// item is wearable by everyone; a server-made item needs membership of its
// server and either 'free' availability or a grant row. There is no
// instance flag, env var or config switch - this implementation IS the
// "everyone" mode.
type everyoneEntitlements struct {
	grants  CosmeticGrantChecker
	members CosmeticMemberChecker
}

// NewEveryoneCosmeticEntitlements returns the everyone-mode entitlements.
func NewEveryoneCosmeticEntitlements(grants CosmeticGrantChecker, members CosmeticMemberChecker) CosmeticEntitlements {
	return &everyoneEntitlements{grants: grants, members: members}
}

func (e *everyoneEntitlements) CanWear(ctx context.Context, userID string, item *models.CosmeticItem) (bool, error) {
	if item == nil {
		return false, nil
	}
	if item.ServerID == nil {
		return true, nil
	}
	member, err := e.members.IsMember(ctx, *item.ServerID, userID)
	if err != nil {
		return false, fmt.Errorf("check cosmetic server membership: %w", err)
	}
	if !member {
		return false, nil
	}
	if item.Availability == models.CosmeticAvailabilityFree {
		return true, nil
	}
	granted, err := e.grants.HasGrant(ctx, userID, item.ID)
	if err != nil {
		return false, fmt.Errorf("check cosmetic grant: %w", err)
	}
	return granted, nil
}
