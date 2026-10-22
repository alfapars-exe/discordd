package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// MockCosmeticRepo satisfies repository.CosmeticRepository. Nil Fn = safe
// default (no rows, nothing changed, GetItem not found), same shape as the
// other mocks_*.go helpers.
type MockCosmeticRepo struct {
	ListBuiltinItemsFn          func(ctx context.Context) ([]models.CosmeticItem, error)
	ListEquippableServerItemsFn func(ctx context.Context, userID string) ([]models.CosmeticItem, error)
	GetItemFn                   func(ctx context.Context, id string) (*models.CosmeticItem, error)
	HasGrantFn                  func(ctx context.Context, userID, itemID string) (bool, error)
	ListGrantsFn                func(ctx context.Context, userID string) ([]models.CosmeticGrant, error)
	ListEquippedFn              func(ctx context.Context, userID string) ([]models.CosmeticEquippedRow, error)
	ApplyEquipFn                func(ctx context.Context, userID, scopeServerID string, set map[string]models.CosmeticEquipRow, unset []string) (bool, error)
	ListPlainServersFn          func(ctx context.Context, userID string) ([]string, error)
	SetPlainServerFn            func(ctx context.Context, userID, serverID string, plain bool) (bool, error)
	IsPlainFn                   func(ctx context.Context, userID, serverID string) (bool, error)
	GlobalSlotsForUsersFn       func(ctx context.Context, ids []string) (map[string]models.CosmeticSlots, error)
	ServerSlotsFn               func(ctx context.Context, serverID string) (map[string]models.CosmeticSlots, error)
	SlotsForUserInServerFn      func(ctx context.Context, userID, serverID string) (models.CosmeticSlots, bool, error)
}

func (m *MockCosmeticRepo) ListBuiltinItems(ctx context.Context) ([]models.CosmeticItem, error) {
	if m.ListBuiltinItemsFn != nil {
		return m.ListBuiltinItemsFn(ctx)
	}
	return []models.CosmeticItem{}, nil
}
func (m *MockCosmeticRepo) ListEquippableServerItems(ctx context.Context, userID string) ([]models.CosmeticItem, error) {
	if m.ListEquippableServerItemsFn != nil {
		return m.ListEquippableServerItemsFn(ctx, userID)
	}
	return []models.CosmeticItem{}, nil
}
func (m *MockCosmeticRepo) GetItem(ctx context.Context, id string) (*models.CosmeticItem, error) {
	if m.GetItemFn != nil {
		return m.GetItemFn(ctx, id)
	}
	return nil, models.ErrCosmeticItemNotFound
}
func (m *MockCosmeticRepo) HasGrant(ctx context.Context, userID, itemID string) (bool, error) {
	if m.HasGrantFn != nil {
		return m.HasGrantFn(ctx, userID, itemID)
	}
	return false, nil
}
func (m *MockCosmeticRepo) ListGrants(ctx context.Context, userID string) ([]models.CosmeticGrant, error) {
	if m.ListGrantsFn != nil {
		return m.ListGrantsFn(ctx, userID)
	}
	return []models.CosmeticGrant{}, nil
}
func (m *MockCosmeticRepo) ListEquipped(ctx context.Context, userID string) ([]models.CosmeticEquippedRow, error) {
	if m.ListEquippedFn != nil {
		return m.ListEquippedFn(ctx, userID)
	}
	return []models.CosmeticEquippedRow{}, nil
}
func (m *MockCosmeticRepo) ApplyEquip(ctx context.Context, userID, scopeServerID string, set map[string]models.CosmeticEquipRow, unset []string) (bool, error) {
	if m.ApplyEquipFn != nil {
		return m.ApplyEquipFn(ctx, userID, scopeServerID, set, unset)
	}
	return false, nil
}
func (m *MockCosmeticRepo) ListPlainServers(ctx context.Context, userID string) ([]string, error) {
	if m.ListPlainServersFn != nil {
		return m.ListPlainServersFn(ctx, userID)
	}
	return []string{}, nil
}
func (m *MockCosmeticRepo) SetPlainServer(ctx context.Context, userID, serverID string, plain bool) (bool, error) {
	if m.SetPlainServerFn != nil {
		return m.SetPlainServerFn(ctx, userID, serverID, plain)
	}
	return false, nil
}
func (m *MockCosmeticRepo) IsPlain(ctx context.Context, userID, serverID string) (bool, error) {
	if m.IsPlainFn != nil {
		return m.IsPlainFn(ctx, userID, serverID)
	}
	return false, nil
}
func (m *MockCosmeticRepo) GlobalSlotsForUsers(ctx context.Context, ids []string) (map[string]models.CosmeticSlots, error) {
	if m.GlobalSlotsForUsersFn != nil {
		return m.GlobalSlotsForUsersFn(ctx, ids)
	}
	return map[string]models.CosmeticSlots{}, nil
}
func (m *MockCosmeticRepo) ServerSlots(ctx context.Context, serverID string) (map[string]models.CosmeticSlots, error) {
	if m.ServerSlotsFn != nil {
		return m.ServerSlotsFn(ctx, serverID)
	}
	return map[string]models.CosmeticSlots{}, nil
}
func (m *MockCosmeticRepo) SlotsForUserInServer(ctx context.Context, userID, serverID string) (models.CosmeticSlots, bool, error) {
	if m.SlotsForUserInServerFn != nil {
		return m.SlotsForUserInServerFn(ctx, userID, serverID)
	}
	return models.CosmeticSlots{}, false, nil
}
