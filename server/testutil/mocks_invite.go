package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// ─── InviteService mock ───
//
// Structurally satisfies services.InviteService without importing the
// services package — testutil importing services back would create an
// import cycle, since services test files (package services) already
// import testutil.

type MockInviteService struct {
	CreateFn           func(ctx context.Context, serverID, createdBy string, req *models.CreateInviteRequest) (*models.Invite, error)
	ListByServerFn     func(ctx context.Context, serverID string) ([]models.InviteWithCreator, error)
	DeleteFn           func(ctx context.Context, code string) error
	ValidateFn         func(ctx context.Context, code string) (*models.Invite, error)
	MarkUsedFn         func(ctx context.Context, code string) error
	IsInviteRequiredFn func(ctx context.Context, serverID string) (bool, error)
	GetPreviewFn       func(ctx context.Context, code string) (*models.InvitePreview, error)
}

func (m *MockInviteService) Create(ctx context.Context, serverID, createdBy string, req *models.CreateInviteRequest) (*models.Invite, error) {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, serverID, createdBy, req)
	}
	return nil, nil
}
func (m *MockInviteService) ListByServer(ctx context.Context, serverID string) ([]models.InviteWithCreator, error) {
	if m.ListByServerFn != nil {
		return m.ListByServerFn(ctx, serverID)
	}
	return nil, nil
}
func (m *MockInviteService) Delete(ctx context.Context, code string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, code)
	}
	return nil
}
func (m *MockInviteService) Validate(ctx context.Context, code string) (*models.Invite, error) {
	if m.ValidateFn != nil {
		return m.ValidateFn(ctx, code)
	}
	return nil, nil
}
func (m *MockInviteService) MarkUsed(ctx context.Context, code string) error {
	if m.MarkUsedFn != nil {
		return m.MarkUsedFn(ctx, code)
	}
	return nil
}
func (m *MockInviteService) IsInviteRequired(ctx context.Context, serverID string) (bool, error) {
	if m.IsInviteRequiredFn != nil {
		return m.IsInviteRequiredFn(ctx, serverID)
	}
	return false, nil
}
func (m *MockInviteService) GetPreview(ctx context.Context, code string) (*models.InvitePreview, error) {
	if m.GetPreviewFn != nil {
		return m.GetPreviewFn(ctx, code)
	}
	return nil, nil
}
