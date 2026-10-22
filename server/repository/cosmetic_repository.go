package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// CosmeticRepository is data access for the cosmetics tables (migration
// 089). Timestamps are returned as RFC3339 UTC (dbTextToRFC3339). List and
// map methods return empty, non-nil values when nothing matches. Item
// Asset fields are left empty - the service fills them from the canonical
// asset (models.CosmeticItem.CanonicalAsset).
type CosmeticRepository interface {
	// ListBuiltinItems returns the first-party catalog (server_id NULL) by
	// type and sort_order.
	ListBuiltinItems(ctx context.Context) ([]models.CosmeticItem, error)
	// ListEquippableServerItems returns the server-made items userID can
	// wear: items of servers userID is a member of that are 'free' or
	// granted to userID.
	ListEquippableServerItems(ctx context.Context, userID string) ([]models.CosmeticItem, error)
	// GetItem returns item id, or models.ErrCosmeticItemNotFound.
	GetItem(ctx context.Context, id string) (*models.CosmeticItem, error)
	// HasGrant reports whether itemID is granted to userID.
	HasGrant(ctx context.Context, userID, itemID string) (bool, error)
	// ListGrants returns userID's grants, oldest first. GrantedBy is nil
	// when the granting account no longer exists.
	ListGrants(ctx context.Context, userID string) ([]models.CosmeticGrant, error)

	// ListEquipped returns every equipped row of userID (all scopes) whose
	// item still exists.
	ListEquipped(ctx context.Context, userID string) ([]models.CosmeticEquippedRow, error)
	// ApplyEquip writes the slots of (userID, scopeServerID) in ONE
	// transaction: every set entry is upserted, every unset type deleted.
	// changed is false when the stored rows already matched (no write).
	ApplyEquip(ctx context.Context, userID, scopeServerID string, set map[string]models.CosmeticEquipRow, unset []string) (changed bool, err error)

	// ListPlainServers returns the servers userID looks plain in.
	ListPlainServers(ctx context.Context, userID string) ([]string, error)
	// SetPlainServer switches "look plain in serverID" on or off; changed
	// is false when it already was in that state.
	SetPlainServer(ctx context.Context, userID, serverID string, plain bool) (changed bool, err error)
	// IsPlain reports whether userID looks plain in serverID.
	IsPlain(ctx context.Context, userID, serverID string) (bool, error)

	// GlobalSlotsForUsers returns the global slots of each of ids (at most
	// models.CosmeticLookupMaxIDs) that has at least one.
	GlobalSlotsForUsers(ctx context.Context, ids []string) (map[string]models.CosmeticSlots, error)
	// ServerSlots returns the resolved slots (server override over global)
	// of every current member of serverID that has at least one and does
	// not look plain there.
	ServerSlots(ctx context.Context, serverID string) (map[string]models.CosmeticSlots, error)
	// SlotsForUserInServer returns userID's resolved slots inside serverID
	// and whether userID looks plain there (then the slots are empty).
	// Membership is not checked.
	SlotsForUserInServer(ctx context.Context, userID, serverID string) (models.CosmeticSlots, bool, error)
}
