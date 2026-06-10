package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// ─── SessionRepository mock ───

type MockSessionRepo struct {
	CreateFn            func(ctx context.Context, session *models.Session) error
	GetByRefreshTokenFn func(ctx context.Context, token string) (*models.Session, error)
	DeleteByIDFn        func(ctx context.Context, id string) error
	DeleteByUserIDFn    func(ctx context.Context, userID string) error
	DeleteExpiredFn     func(ctx context.Context) error
}

func (m *MockSessionRepo) Create(ctx context.Context, session *models.Session) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, session)
	}
	return nil
}
func (m *MockSessionRepo) GetByRefreshToken(ctx context.Context, token string) (*models.Session, error) {
	return m.GetByRefreshTokenFn(ctx, token)
}
func (m *MockSessionRepo) DeleteByID(ctx context.Context, id string) error {
	if m.DeleteByIDFn != nil {
		return m.DeleteByIDFn(ctx, id)
	}
	return nil
}
func (m *MockSessionRepo) DeleteByUserID(ctx context.Context, userID string) error {
	if m.DeleteByUserIDFn != nil {
		return m.DeleteByUserIDFn(ctx, userID)
	}
	return nil
}
func (m *MockSessionRepo) DeleteExpired(ctx context.Context) error {
	if m.DeleteExpiredFn != nil {
		return m.DeleteExpiredFn(ctx)
	}
	return nil
}

// ─── PasswordResetRepository mock ───

type MockResetRepo struct {
	CreateFn            func(ctx context.Context, token *models.PasswordResetToken) error
	GetByTokenHashFn    func(ctx context.Context, tokenHash string) (*models.PasswordResetToken, error)
	DeleteByIDFn        func(ctx context.Context, id string) error
	DeleteByUserIDFn    func(ctx context.Context, userID string) error
	DeleteExpiredFn     func(ctx context.Context) error
	GetLatestByUserIDFn func(ctx context.Context, userID string) (*models.PasswordResetToken, error)
}

func (m *MockResetRepo) Create(ctx context.Context, token *models.PasswordResetToken) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, token)
	}
	return nil
}
func (m *MockResetRepo) GetByTokenHash(ctx context.Context, tokenHash string) (*models.PasswordResetToken, error) {
	if m.GetByTokenHashFn != nil {
		return m.GetByTokenHashFn(ctx, tokenHash)
	}
	return nil, nil
}
func (m *MockResetRepo) DeleteByID(ctx context.Context, id string) error {
	if m.DeleteByIDFn != nil {
		return m.DeleteByIDFn(ctx, id)
	}
	return nil
}
func (m *MockResetRepo) DeleteByUserID(ctx context.Context, userID string) error {
	if m.DeleteByUserIDFn != nil {
		return m.DeleteByUserIDFn(ctx, userID)
	}
	return nil
}
func (m *MockResetRepo) DeleteExpired(ctx context.Context) error {
	if m.DeleteExpiredFn != nil {
		return m.DeleteExpiredFn(ctx)
	}
	return nil
}
func (m *MockResetRepo) GetLatestByUserID(ctx context.Context, userID string) (*models.PasswordResetToken, error) {
	if m.GetLatestByUserIDFn != nil {
		return m.GetLatestByUserIDFn(ctx, userID)
	}
	return nil, nil
}
