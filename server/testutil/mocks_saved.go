package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// MockSavedRepo satisfies repository.SavedRepository. Nil Fn = safe default
// (no rows, success), same shape as the other mocks_*.go helpers.
type MockSavedRepo struct {
	CreateFn     func(ctx context.Context, s *models.SavedMessage) error
	GetByIDFn    func(ctx context.Context, userID, id string) (*models.SavedMessage, error)
	FindByRefFn  func(ctx context.Context, userID, messageID, dmMessageID string) (*models.SavedMessage, error)
	ListFn       func(ctx context.Context, userID, beforeID string, limit int) ([]models.SavedMessage, error)
	ListIDsFn    func(ctx context.Context, userID string) ([]string, []string, error)
	CountFn      func(ctx context.Context, userID string) (int, error)
	UpdateNoteFn func(ctx context.Context, userID, id string, note *string) (bool, error)
	DeleteFn     func(ctx context.Context, userID, id string) (bool, error)
}

func (m *MockSavedRepo) Create(ctx context.Context, s *models.SavedMessage) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, s)
	}
	if s.ID == "" {
		s.ID = "saved-1"
	}
	return nil
}
func (m *MockSavedRepo) GetByID(ctx context.Context, userID, id string) (*models.SavedMessage, error) {
	if m.GetByIDFn != nil {
		return m.GetByIDFn(ctx, userID, id)
	}
	return &models.SavedMessage{ID: id, UserID: userID}, nil
}
func (m *MockSavedRepo) FindByRef(ctx context.Context, userID, messageID, dmMessageID string) (*models.SavedMessage, error) {
	if m.FindByRefFn != nil {
		return m.FindByRefFn(ctx, userID, messageID, dmMessageID)
	}
	return nil, nil
}
func (m *MockSavedRepo) List(ctx context.Context, userID, beforeID string, limit int) ([]models.SavedMessage, error) {
	if m.ListFn != nil {
		return m.ListFn(ctx, userID, beforeID, limit)
	}
	return []models.SavedMessage{}, nil
}
func (m *MockSavedRepo) ListIDs(ctx context.Context, userID string) ([]string, []string, error) {
	if m.ListIDsFn != nil {
		return m.ListIDsFn(ctx, userID)
	}
	return []string{}, []string{}, nil
}
func (m *MockSavedRepo) Count(ctx context.Context, userID string) (int, error) {
	if m.CountFn != nil {
		return m.CountFn(ctx, userID)
	}
	return 0, nil
}
func (m *MockSavedRepo) UpdateNote(ctx context.Context, userID, id string, note *string) (bool, error) {
	if m.UpdateNoteFn != nil {
		return m.UpdateNoteFn(ctx, userID, id, note)
	}
	return true, nil
}
func (m *MockSavedRepo) Delete(ctx context.Context, userID, id string) (bool, error) {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, userID, id)
	}
	return true, nil
}

// MockUserNoteRepo satisfies repository.UserNoteRepository.
type MockUserNoteRepo struct {
	GetFn    func(ctx context.Context, ownerUserID, targetUserID string) (string, *string, error)
	UpsertFn func(ctx context.Context, ownerUserID, targetUserID, note string) (string, error)
	DeleteFn func(ctx context.Context, ownerUserID, targetUserID string) error
}

func (m *MockUserNoteRepo) Get(ctx context.Context, ownerUserID, targetUserID string) (string, *string, error) {
	if m.GetFn != nil {
		return m.GetFn(ctx, ownerUserID, targetUserID)
	}
	return "", nil, nil
}
func (m *MockUserNoteRepo) Upsert(ctx context.Context, ownerUserID, targetUserID, note string) (string, error) {
	if m.UpsertFn != nil {
		return m.UpsertFn(ctx, ownerUserID, targetUserID, note)
	}
	return "2026-01-01T00:00:00Z", nil
}
func (m *MockUserNoteRepo) Delete(ctx context.Context, ownerUserID, targetUserID string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, ownerUserID, targetUserID)
	}
	return nil
}
