package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// ─── RoleRepository mock ───

type MockRoleRepo struct {
	GetByIDFn              func(ctx context.Context, id string) (*models.Role, error)
	GetAllByServerFn       func(ctx context.Context, serverID string) ([]models.Role, error)
	GetDefaultByServerFn   func(ctx context.Context, serverID string) (*models.Role, error)
	GetByUserIDAndServerFn func(ctx context.Context, userID, serverID string) ([]models.Role, error)
	GetMaxPositionFn       func(ctx context.Context, serverID string) (int, error)
	CreateFn               func(ctx context.Context, role *models.Role) error
	UpdateFn               func(ctx context.Context, role *models.Role) error
	DeleteFn               func(ctx context.Context, id string) error
	UpdatePositionsFn      func(ctx context.Context, items []models.PositionUpdate) error
	AssignToUserFn         func(ctx context.Context, userID, roleID, serverID string) error
	RemoveFromUserFn       func(ctx context.Context, userID, roleID string) error
}

func (m *MockRoleRepo) GetByID(ctx context.Context, id string) (*models.Role, error) {
	if m.GetByIDFn != nil {
		return m.GetByIDFn(ctx, id)
	}
	return nil, nil
}
func (m *MockRoleRepo) GetAllByServer(ctx context.Context, serverID string) ([]models.Role, error) {
	if m.GetAllByServerFn != nil {
		return m.GetAllByServerFn(ctx, serverID)
	}
	return nil, nil
}
func (m *MockRoleRepo) GetDefaultByServer(ctx context.Context, serverID string) (*models.Role, error) {
	if m.GetDefaultByServerFn != nil {
		return m.GetDefaultByServerFn(ctx, serverID)
	}
	return nil, nil
}
func (m *MockRoleRepo) GetByUserIDAndServer(ctx context.Context, userID, serverID string) ([]models.Role, error) {
	if m.GetByUserIDAndServerFn != nil {
		return m.GetByUserIDAndServerFn(ctx, userID, serverID)
	}
	return nil, nil
}
func (m *MockRoleRepo) GetMaxPosition(ctx context.Context, serverID string) (int, error) {
	if m.GetMaxPositionFn != nil {
		return m.GetMaxPositionFn(ctx, serverID)
	}
	return 0, nil
}
func (m *MockRoleRepo) Create(ctx context.Context, role *models.Role) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, role)
	}
	return nil
}
func (m *MockRoleRepo) Update(ctx context.Context, role *models.Role) error {
	if m.UpdateFn != nil {
		return m.UpdateFn(ctx, role)
	}
	return nil
}
func (m *MockRoleRepo) Delete(ctx context.Context, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, id)
	}
	return nil
}
func (m *MockRoleRepo) UpdatePositions(ctx context.Context, items []models.PositionUpdate) error {
	if m.UpdatePositionsFn != nil {
		return m.UpdatePositionsFn(ctx, items)
	}
	return nil
}
func (m *MockRoleRepo) AssignToUser(ctx context.Context, userID, roleID, serverID string) error {
	if m.AssignToUserFn != nil {
		return m.AssignToUserFn(ctx, userID, roleID, serverID)
	}
	return nil
}
func (m *MockRoleRepo) RemoveFromUser(ctx context.Context, userID, roleID string) error {
	if m.RemoveFromUserFn != nil {
		return m.RemoveFromUserFn(ctx, userID, roleID)
	}
	return nil
}

// ─── ChannelPermissionRepository mock ───

type MockChannelPermRepo struct {
	GetByChannelFn         func(ctx context.Context, channelID string) ([]models.ChannelPermissionOverride, error)
	GetByChannelAndRolesFn func(ctx context.Context, channelID string, roleIDs []string) ([]models.ChannelPermissionOverride, error)
	GetByRolesFn           func(ctx context.Context, roleIDs []string) ([]models.ChannelPermissionOverride, error)
	SetFn                  func(ctx context.Context, override *models.ChannelPermissionOverride) error
	DeleteFn               func(ctx context.Context, channelID, roleID string) error
	DeleteAllByChannelFn   func(ctx context.Context, channelID string) error
}

func (m *MockChannelPermRepo) GetByChannel(ctx context.Context, channelID string) ([]models.ChannelPermissionOverride, error) {
	if m.GetByChannelFn != nil {
		return m.GetByChannelFn(ctx, channelID)
	}
	return nil, nil
}
func (m *MockChannelPermRepo) GetByChannelAndRoles(ctx context.Context, channelID string, roleIDs []string) ([]models.ChannelPermissionOverride, error) {
	if m.GetByChannelAndRolesFn != nil {
		return m.GetByChannelAndRolesFn(ctx, channelID, roleIDs)
	}
	return nil, nil
}
func (m *MockChannelPermRepo) GetByRoles(ctx context.Context, roleIDs []string) ([]models.ChannelPermissionOverride, error) {
	if m.GetByRolesFn != nil {
		return m.GetByRolesFn(ctx, roleIDs)
	}
	return nil, nil
}
func (m *MockChannelPermRepo) Set(ctx context.Context, override *models.ChannelPermissionOverride) error {
	if m.SetFn != nil {
		return m.SetFn(ctx, override)
	}
	return nil
}
func (m *MockChannelPermRepo) Delete(ctx context.Context, channelID, roleID string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, channelID, roleID)
	}
	return nil
}
func (m *MockChannelPermRepo) DeleteAllByChannel(ctx context.Context, channelID string) error {
	if m.DeleteAllByChannelFn != nil {
		return m.DeleteAllByChannelFn(ctx, channelID)
	}
	return nil
}

// ─── ChannelPermResolver mock ───

type MockChannelPermResolver struct {
	ResolveChannelPermissionsFn func(ctx context.Context, userID, channelID string) (models.Permission, error)
}

func (m *MockChannelPermResolver) ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error) {
	if m.ResolveChannelPermissionsFn != nil {
		return m.ResolveChannelPermissionsFn(ctx, userID, channelID)
	}
	return 0, nil
}
