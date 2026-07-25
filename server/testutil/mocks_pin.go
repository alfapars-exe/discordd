package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

// ─── PinRepository mock ───

type MockPinRepo struct {
	GetByChannelIDFn   func(ctx context.Context, channelID string) ([]models.PinnedMessageWithDetails, error)
	PinFn              func(ctx context.Context, pin *models.PinnedMessage) error
	UnpinFn            func(ctx context.Context, messageID string) error
	IsPinnedFn         func(ctx context.Context, messageID string) (bool, error)
	CountByChannelIDFn func(ctx context.Context, channelID string) (int, error)
}

func (m *MockPinRepo) GetByChannelID(ctx context.Context, channelID string) ([]models.PinnedMessageWithDetails, error) {
	if m.GetByChannelIDFn != nil {
		return m.GetByChannelIDFn(ctx, channelID)
	}
	return nil, nil
}
func (m *MockPinRepo) Pin(ctx context.Context, pin *models.PinnedMessage) error {
	if m.PinFn != nil {
		return m.PinFn(ctx, pin)
	}
	return nil
}
func (m *MockPinRepo) Unpin(ctx context.Context, messageID string) error {
	if m.UnpinFn != nil {
		return m.UnpinFn(ctx, messageID)
	}
	return nil
}
func (m *MockPinRepo) IsPinned(ctx context.Context, messageID string) (bool, error) {
	if m.IsPinnedFn != nil {
		return m.IsPinnedFn(ctx, messageID)
	}
	return false, nil
}
func (m *MockPinRepo) CountByChannelID(ctx context.Context, channelID string) (int, error) {
	if m.CountByChannelIDFn != nil {
		return m.CountByChannelIDFn(ctx, channelID)
	}
	return 0, nil
}

var _ repository.PinRepository = (*MockPinRepo)(nil)
