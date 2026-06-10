package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// ─── BanRepository mock ───

type MockBanRepo struct {
	CreateFn         func(ctx context.Context, ban *models.Ban) error
	GetByUserIDFn    func(ctx context.Context, serverID, userID string) (*models.Ban, error)
	GetAllByServerFn func(ctx context.Context, serverID string) ([]models.Ban, error)
	DeleteFn         func(ctx context.Context, serverID, userID string) error
	ExistsFn         func(ctx context.Context, serverID, userID string) (bool, error)
}

func (m *MockBanRepo) Create(ctx context.Context, ban *models.Ban) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, ban)
	}
	return nil
}
func (m *MockBanRepo) GetByUserID(ctx context.Context, serverID, userID string) (*models.Ban, error) {
	if m.GetByUserIDFn != nil {
		return m.GetByUserIDFn(ctx, serverID, userID)
	}
	return nil, nil
}
func (m *MockBanRepo) GetAllByServer(ctx context.Context, serverID string) ([]models.Ban, error) {
	if m.GetAllByServerFn != nil {
		return m.GetAllByServerFn(ctx, serverID)
	}
	return nil, nil
}
func (m *MockBanRepo) Delete(ctx context.Context, serverID, userID string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, serverID, userID)
	}
	return nil
}
func (m *MockBanRepo) Exists(ctx context.Context, serverID, userID string) (bool, error) {
	if m.ExistsFn != nil {
		return m.ExistsFn(ctx, serverID, userID)
	}
	return false, nil
}

// ─── MemberTimeoutRepository mock ───

type MockMemberTimeoutRepo struct {
	UpsertFn     func(ctx context.Context, t *models.MemberTimeout) error
	GetFn        func(ctx context.Context, serverID, userID string) (*models.MemberTimeout, error)
	DeleteFn     func(ctx context.Context, serverID, userID string) error
	IsActiveFn   func(ctx context.Context, serverID, userID string) (bool, error)
	ListActiveFn func(ctx context.Context, serverID string) ([]models.MemberTimeout, error)
}

func (m *MockMemberTimeoutRepo) Upsert(ctx context.Context, t *models.MemberTimeout) error {
	if m.UpsertFn != nil {
		return m.UpsertFn(ctx, t)
	}
	return nil
}
func (m *MockMemberTimeoutRepo) Get(ctx context.Context, serverID, userID string) (*models.MemberTimeout, error) {
	if m.GetFn != nil {
		return m.GetFn(ctx, serverID, userID)
	}
	return nil, nil
}
func (m *MockMemberTimeoutRepo) Delete(ctx context.Context, serverID, userID string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, serverID, userID)
	}
	return nil
}
func (m *MockMemberTimeoutRepo) IsActive(ctx context.Context, serverID, userID string) (bool, error) {
	if m.IsActiveFn != nil {
		return m.IsActiveFn(ctx, serverID, userID)
	}
	return false, nil
}
func (m *MockMemberTimeoutRepo) ListActive(ctx context.Context, serverID string) ([]models.MemberTimeout, error) {
	if m.ListActiveFn != nil {
		return m.ListActiveFn(ctx, serverID)
	}
	return nil, nil
}

// MockVoiceDisconnecter satisfies services.VoiceDisconnecter for member tests
// where Kick/Ban paths call voiceKick.DisconnectUser.
type MockVoiceDisconnecter struct {
	DisconnectUserFn func(userID string)
	DisconnectedIDs  []string
}

func (m *MockVoiceDisconnecter) DisconnectUser(userID string) {
	m.DisconnectedIDs = append(m.DisconnectedIDs, userID)
	if m.DisconnectUserFn != nil {
		m.DisconnectUserFn(userID)
	}
}
