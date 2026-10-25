package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// ─── UserRepository mock ───

type MockUserRepo struct {
	CreateFn                  func(ctx context.Context, user *models.User) error
	CreateWithSessionFn       func(ctx context.Context, user *models.User, session *models.Session) error
	GetByIDFn                 func(ctx context.Context, id string) (*models.User, error)
	GetByUsernameFn           func(ctx context.Context, username string) (*models.User, error)
	GetAllFn                  func(ctx context.Context) ([]models.User, error)
	UpdateFn                  func(ctx context.Context, user *models.User) error
	UpdateStatusFn            func(ctx context.Context, userID string, status models.UserStatus) error
	UpdateManualPresenceFn    func(ctx context.Context, userID string, status models.UserStatus) error
	UpdatePasswordFn          func(ctx context.Context, userID string, newPasswordHash string) error
	UpdateEmailFn             func(ctx context.Context, userID string, email *string) error
	GetByEmailFn              func(ctx context.Context, email string) (*models.User, error)
	CountFn                   func(ctx context.Context) (int, error)
	DeleteFn                  func(ctx context.Context, id string) error
	ListAllUsersWithStatsFn   func(ctx context.Context) ([]models.AdminUserListItem, error)
	UpdateLastVoiceActivityFn func(ctx context.Context, userID string) error
	PlatformBanFn             func(ctx context.Context, userID, reason, bannedBy string) error
	PlatformUnbanFn           func(ctx context.Context, userID string) error
	IsEmailPlatformBannedFn   func(ctx context.Context, email string) (bool, error)
	DeleteAllMessagesByUserFn func(ctx context.Context, userID string) error
	HardDeleteUserFn          func(ctx context.Context, userID, reassignToUserID string) error
	GetOwnedServerFileURLsFn  func(ctx context.Context, userID string) ([]string, error)
	SetPlatformAdminFn        func(ctx context.Context, userID string, isAdmin bool) error
	IncrementTokenVersionFn   func(ctx context.Context, userID string) error
}

func (m *MockUserRepo) Create(ctx context.Context, user *models.User) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, user)
	}
	return nil
}
func (m *MockUserRepo) CreateWithSession(ctx context.Context, user *models.User, session *models.Session) error {
	if m.CreateWithSessionFn != nil {
		return m.CreateWithSessionFn(ctx, user, session)
	}
	return nil
}
func (m *MockUserRepo) GetByID(ctx context.Context, id string) (*models.User, error) {
	return m.GetByIDFn(ctx, id)
}
func (m *MockUserRepo) GetByUsername(ctx context.Context, username string) (*models.User, error) {
	if m.GetByUsernameFn != nil {
		return m.GetByUsernameFn(ctx, username)
	}
	return nil, pkg.ErrNotFound
}
func (m *MockUserRepo) GetAll(ctx context.Context) ([]models.User, error) {
	if m.GetAllFn != nil {
		return m.GetAllFn(ctx)
	}
	return nil, nil
}
func (m *MockUserRepo) Update(ctx context.Context, user *models.User) error {
	if m.UpdateFn != nil {
		return m.UpdateFn(ctx, user)
	}
	return nil
}
func (m *MockUserRepo) UpdateStatus(ctx context.Context, userID string, status models.UserStatus) error {
	if m.UpdateStatusFn != nil {
		return m.UpdateStatusFn(ctx, userID, status)
	}
	return nil
}
func (m *MockUserRepo) UpdatePassword(ctx context.Context, userID string, newPasswordHash string) error {
	if m.UpdatePasswordFn != nil {
		return m.UpdatePasswordFn(ctx, userID, newPasswordHash)
	}
	return nil
}
func (m *MockUserRepo) UpdateEmail(ctx context.Context, userID string, email *string) error {
	if m.UpdateEmailFn != nil {
		return m.UpdateEmailFn(ctx, userID, email)
	}
	return nil
}
func (m *MockUserRepo) UpdateWallpaper(_ context.Context, _ string, _ *string) error {
	return nil
}
func (m *MockUserRepo) GetByEmail(ctx context.Context, email string) (*models.User, error) {
	if m.GetByEmailFn != nil {
		return m.GetByEmailFn(ctx, email)
	}
	return nil, nil
}
func (m *MockUserRepo) Count(ctx context.Context) (int, error) {
	if m.CountFn != nil {
		return m.CountFn(ctx)
	}
	return 0, nil
}
func (m *MockUserRepo) Delete(ctx context.Context, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, id)
	}
	return nil
}
func (m *MockUserRepo) ListAllUsersWithStats(ctx context.Context) ([]models.AdminUserListItem, error) {
	if m.ListAllUsersWithStatsFn != nil {
		return m.ListAllUsersWithStatsFn(ctx)
	}
	return nil, nil
}
func (m *MockUserRepo) UpdateLastVoiceActivity(ctx context.Context, userID string) error {
	if m.UpdateLastVoiceActivityFn != nil {
		return m.UpdateLastVoiceActivityFn(ctx, userID)
	}
	return nil
}
func (m *MockUserRepo) PlatformBan(ctx context.Context, userID, reason, bannedBy string) error {
	if m.PlatformBanFn != nil {
		return m.PlatformBanFn(ctx, userID, reason, bannedBy)
	}
	return nil
}
func (m *MockUserRepo) PlatformUnban(ctx context.Context, userID string) error {
	if m.PlatformUnbanFn != nil {
		return m.PlatformUnbanFn(ctx, userID)
	}
	return nil
}
func (m *MockUserRepo) IsEmailPlatformBanned(ctx context.Context, email string) (bool, error) {
	if m.IsEmailPlatformBannedFn != nil {
		return m.IsEmailPlatformBannedFn(ctx, email)
	}
	return false, nil
}
func (m *MockUserRepo) DeleteAllMessagesByUser(ctx context.Context, userID string) error {
	if m.DeleteAllMessagesByUserFn != nil {
		return m.DeleteAllMessagesByUserFn(ctx, userID)
	}
	return nil
}
func (m *MockUserRepo) HardDeleteUser(ctx context.Context, userID, reassignToUserID string) error {
	if m.HardDeleteUserFn != nil {
		return m.HardDeleteUserFn(ctx, userID, reassignToUserID)
	}
	return nil
}
func (m *MockUserRepo) GetOwnedServerFileURLs(ctx context.Context, userID string) ([]string, error) {
	if m.GetOwnedServerFileURLsFn != nil {
		return m.GetOwnedServerFileURLsFn(ctx, userID)
	}
	return nil, nil
}
func (m *MockUserRepo) SetPlatformAdmin(ctx context.Context, userID string, isAdmin bool) error {
	if m.SetPlatformAdminFn != nil {
		return m.SetPlatformAdminFn(ctx, userID, isAdmin)
	}
	return nil
}

// IncrementTokenVersion delegates to IncrementTokenVersionFn when set,
// nil-safe otherwise (matches every other optional hook on this mock).
func (m *MockUserRepo) IncrementTokenVersion(ctx context.Context, userID string) error {
	if m.IncrementTokenVersionFn != nil {
		return m.IncrementTokenVersionFn(ctx, userID)
	}
	return nil
}

// SetDownloadPromptSeen — stub; download-prompt state isn't asserted in tests.
func (m *MockUserRepo) SetDownloadPromptSeen(_ context.Context, _ string) error {
	return nil
}

// SetWelcomeSeen — stub; welcome-seen state isn't asserted in tests.
func (m *MockUserRepo) SetWelcomeSeen(_ context.Context, _ string) error {
	return nil
}

// UpdatePrefStatus — stub; preferred-status updates aren't asserted in tests.
func (m *MockUserRepo) UpdatePrefStatus(_ context.Context, _ string, _ models.UserStatus) error {
	return nil
}

// UpdateManualPresence keeps callback tests aligned with the atomic status
// and preference persistence contract.
func (m *MockUserRepo) UpdateManualPresence(ctx context.Context, userID string, status models.UserStatus) error {
	if m.UpdateManualPresenceFn != nil {
		return m.UpdateManualPresenceFn(ctx, userID, status)
	}
	return nil
}
