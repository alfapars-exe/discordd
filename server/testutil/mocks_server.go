package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// ─── ServerRepository mock (minimal — only methods touched by member_service tests) ───
//
// The real interface in repository/server_repository.go is large (16+
// methods). To keep mocks.go from bloating, every method defaults to a
// safe zero-value return. Tests override only the Fn fields they
// actually need; everything else is a no-op.

type MockServerRepo struct {
	CreateFn                      func(ctx context.Context, server *models.Server) error
	GetByIDFn                     func(ctx context.Context, serverID string) (*models.Server, error)
	UpdateFn                      func(ctx context.Context, server *models.Server) error
	DeleteFn                      func(ctx context.Context, serverID string) error
	GetUserServersFn              func(ctx context.Context, userID string) ([]models.ServerListItem, error)
	AddMemberFn                   func(ctx context.Context, serverID, userID string) error
	RemoveMemberFn                func(ctx context.Context, serverID, userID string) error
	IsMemberFn                    func(ctx context.Context, serverID, userID string) (bool, error)
	GetMemberCountFn              func(ctx context.Context, serverID string) (int, error)
	GetMemberServerIDsFn          func(ctx context.Context, userID string) ([]string, error)
	GetNicknameFn                 func(ctx context.Context, serverID, userID string) (*string, error)
	SetNicknameFn                 func(ctx context.Context, serverID, userID string, nickname *string) error
	GetNicknamesForServerFn       func(ctx context.Context, serverID string) (map[string]string, error)
	UpdateMemberPositionsFn       func(ctx context.Context, userID string, items []models.PositionUpdate) error
	GetMaxMemberPositionFn        func(ctx context.Context, userID string) (int, error)
	ListAllWithStatsFn            func(ctx context.Context) ([]models.AdminServerListItem, error)
	UpdateLastVoiceActivityFn     func(ctx context.Context, serverID string) error
	CountOwnedMqviHostedServersFn func(ctx context.Context, ownerID string) (int, error)
}

func (m *MockServerRepo) Create(ctx context.Context, server *models.Server) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, server)
	}
	return nil
}
func (m *MockServerRepo) GetByID(ctx context.Context, serverID string) (*models.Server, error) {
	if m.GetByIDFn != nil {
		return m.GetByIDFn(ctx, serverID)
	}
	return nil, nil
}
func (m *MockServerRepo) Update(ctx context.Context, server *models.Server) error {
	if m.UpdateFn != nil {
		return m.UpdateFn(ctx, server)
	}
	return nil
}
func (m *MockServerRepo) Delete(ctx context.Context, serverID string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, serverID)
	}
	return nil
}
func (m *MockServerRepo) GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error) {
	if m.GetUserServersFn != nil {
		return m.GetUserServersFn(ctx, userID)
	}
	return nil, nil
}
func (m *MockServerRepo) AddMember(ctx context.Context, serverID, userID string) error {
	if m.AddMemberFn != nil {
		return m.AddMemberFn(ctx, serverID, userID)
	}
	return nil
}
func (m *MockServerRepo) RemoveMember(ctx context.Context, serverID, userID string) error {
	if m.RemoveMemberFn != nil {
		return m.RemoveMemberFn(ctx, serverID, userID)
	}
	return nil
}
func (m *MockServerRepo) IsMember(ctx context.Context, serverID, userID string) (bool, error) {
	if m.IsMemberFn != nil {
		return m.IsMemberFn(ctx, serverID, userID)
	}
	return false, nil
}
func (m *MockServerRepo) GetMemberCount(ctx context.Context, serverID string) (int, error) {
	if m.GetMemberCountFn != nil {
		return m.GetMemberCountFn(ctx, serverID)
	}
	return 0, nil
}
func (m *MockServerRepo) GetMemberServerIDs(ctx context.Context, userID string) ([]string, error) {
	if m.GetMemberServerIDsFn != nil {
		return m.GetMemberServerIDsFn(ctx, userID)
	}
	return nil, nil
}
func (m *MockServerRepo) GetNickname(ctx context.Context, serverID, userID string) (*string, error) {
	if m.GetNicknameFn != nil {
		return m.GetNicknameFn(ctx, serverID, userID)
	}
	return nil, nil
}
func (m *MockServerRepo) SetNickname(ctx context.Context, serverID, userID string, nickname *string) error {
	if m.SetNicknameFn != nil {
		return m.SetNicknameFn(ctx, serverID, userID, nickname)
	}
	return nil
}
func (m *MockServerRepo) GetNicknamesForServer(ctx context.Context, serverID string) (map[string]string, error) {
	if m.GetNicknamesForServerFn != nil {
		return m.GetNicknamesForServerFn(ctx, serverID)
	}
	return map[string]string{}, nil
}
func (m *MockServerRepo) UpdateMemberPositions(ctx context.Context, userID string, items []models.PositionUpdate) error {
	if m.UpdateMemberPositionsFn != nil {
		return m.UpdateMemberPositionsFn(ctx, userID, items)
	}
	return nil
}
func (m *MockServerRepo) GetMaxMemberPosition(ctx context.Context, userID string) (int, error) {
	if m.GetMaxMemberPositionFn != nil {
		return m.GetMaxMemberPositionFn(ctx, userID)
	}
	return 0, nil
}
func (m *MockServerRepo) ListAllWithStats(ctx context.Context) ([]models.AdminServerListItem, error) {
	if m.ListAllWithStatsFn != nil {
		return m.ListAllWithStatsFn(ctx)
	}
	return nil, nil
}
func (m *MockServerRepo) UpdateLastVoiceActivity(ctx context.Context, serverID string) error {
	if m.UpdateLastVoiceActivityFn != nil {
		return m.UpdateLastVoiceActivityFn(ctx, serverID)
	}
	return nil
}
func (m *MockServerRepo) CountOwnedMqviHostedServers(ctx context.Context, ownerID string) (int, error) {
	if m.CountOwnedMqviHostedServersFn != nil {
		return m.CountOwnedMqviHostedServersFn(ctx, ownerID)
	}
	return 0, nil
}
