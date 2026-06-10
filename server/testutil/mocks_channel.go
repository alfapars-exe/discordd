package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// ─── ChannelRepository mock (ChannelGetter) ───

type MockChannelRepo struct {
	GetByIDFn         func(ctx context.Context, id string) (*models.Channel, error)
	GetAllByServerFn  func(ctx context.Context, serverID string) ([]models.Channel, error)
	GetByCategoryIDFn func(ctx context.Context, categoryID string) ([]models.Channel, error)
	CreateFn          func(ctx context.Context, channel *models.Channel) error
	UpdateFn          func(ctx context.Context, channel *models.Channel) error
	DeleteFn          func(ctx context.Context, id string) error
	GetMaxPositionFn  func(ctx context.Context, categoryID string) (int, error)
	UpdatePositionsFn func(ctx context.Context, items []models.PositionUpdate) error
}

func (m *MockChannelRepo) GetByID(ctx context.Context, id string) (*models.Channel, error) {
	if m.GetByIDFn != nil {
		return m.GetByIDFn(ctx, id)
	}
	return nil, nil
}
func (m *MockChannelRepo) GetAllByServer(ctx context.Context, serverID string) ([]models.Channel, error) {
	if m.GetAllByServerFn != nil {
		return m.GetAllByServerFn(ctx, serverID)
	}
	return nil, nil
}
func (m *MockChannelRepo) GetByCategoryID(ctx context.Context, categoryID string) ([]models.Channel, error) {
	if m.GetByCategoryIDFn != nil {
		return m.GetByCategoryIDFn(ctx, categoryID)
	}
	return nil, nil
}
func (m *MockChannelRepo) Create(ctx context.Context, channel *models.Channel) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, channel)
	}
	return nil
}
func (m *MockChannelRepo) Update(ctx context.Context, channel *models.Channel) error {
	if m.UpdateFn != nil {
		return m.UpdateFn(ctx, channel)
	}
	return nil
}
func (m *MockChannelRepo) Delete(ctx context.Context, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, id)
	}
	return nil
}
func (m *MockChannelRepo) GetMaxPosition(ctx context.Context, categoryID string) (int, error) {
	if m.GetMaxPositionFn != nil {
		return m.GetMaxPositionFn(ctx, categoryID)
	}
	return 0, nil
}
func (m *MockChannelRepo) UpdatePositions(ctx context.Context, items []models.PositionUpdate) error {
	if m.UpdatePositionsFn != nil {
		return m.UpdatePositionsFn(ctx, items)
	}
	return nil
}
