package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

// ─── SoundboardRepository mock ───

type MockSoundboardRepo struct {
	CreateFn        func(ctx context.Context, sound *models.SoundboardSound) error
	GetByIDFn       func(ctx context.Context, id string) (*models.SoundboardSound, error)
	ListByServerFn  func(ctx context.Context, serverID string) ([]models.SoundboardSound, error)
	UpdateFn        func(ctx context.Context, sound *models.SoundboardSound) error
	DeleteFn        func(ctx context.Context, id string) error
	CountByServerFn func(ctx context.Context, serverID string) (int, error)
}

func (m *MockSoundboardRepo) Create(ctx context.Context, sound *models.SoundboardSound) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, sound)
	}
	return nil
}
func (m *MockSoundboardRepo) GetByID(ctx context.Context, id string) (*models.SoundboardSound, error) {
	if m.GetByIDFn != nil {
		return m.GetByIDFn(ctx, id)
	}
	return nil, nil
}
func (m *MockSoundboardRepo) ListByServer(ctx context.Context, serverID string) ([]models.SoundboardSound, error) {
	if m.ListByServerFn != nil {
		return m.ListByServerFn(ctx, serverID)
	}
	return nil, nil
}
func (m *MockSoundboardRepo) Update(ctx context.Context, sound *models.SoundboardSound) error {
	if m.UpdateFn != nil {
		return m.UpdateFn(ctx, sound)
	}
	return nil
}
func (m *MockSoundboardRepo) Delete(ctx context.Context, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, id)
	}
	return nil
}
func (m *MockSoundboardRepo) CountByServer(ctx context.Context, serverID string) (int, error) {
	if m.CountByServerFn != nil {
		return m.CountByServerFn(ctx, serverID)
	}
	return 0, nil
}

var _ repository.SoundboardRepository = (*MockSoundboardRepo)(nil)

// ─── VoiceStateGetter mock ───

type MockVoiceStateGetter struct {
	GetUserVoiceStateFn      func(userID string) *models.VoiceState
	GetChannelParticipantsFn func(channelID string) []models.VoiceState
}

func (m *MockVoiceStateGetter) GetUserVoiceState(userID string) *models.VoiceState {
	if m.GetUserVoiceStateFn != nil {
		return m.GetUserVoiceStateFn(userID)
	}
	return nil
}
func (m *MockVoiceStateGetter) GetChannelParticipants(channelID string) []models.VoiceState {
	if m.GetChannelParticipantsFn != nil {
		return m.GetChannelParticipantsFn(channelID)
	}
	return nil
}
