package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// MockDMRepo — function-field mock following the same shape as the
// other mocks_*.go helpers. Only fields for methods actually exercised
// by dm_message tests are populated by tests; the zero-value stub
// returns a safe default so unrelated code paths don't panic.
type MockDMRepo struct {
	GetChannelByIDFn         func(ctx context.Context, id string) (*models.DMChannel, error)
	GetChannelByUsersFn      func(ctx context.Context, u1, u2 string) (*models.DMChannel, error)
	CountMessagesBySenderFn  func(ctx context.Context, channelID, userID string) (int, error)
	UpdateChannelStatusFn    func(ctx context.Context, channelID, status string) error
	SetInitiatedByFn         func(ctx context.Context, channelID, userID string) error
	CreateMessageFn          func(ctx context.Context, msg *models.DMMessage) error
	GetMessageByIDFn         func(ctx context.Context, id string) (*models.DMMessage, error)
	UpdateMessageFn          func(ctx context.Context, id string, req *models.UpdateDMMessageRequest) error
	DeleteMessageFn          func(ctx context.Context, id string) error
}

func (m *MockDMRepo) GetChannelByUsers(ctx context.Context, u1, u2 string) (*models.DMChannel, error) {
	if m.GetChannelByUsersFn != nil {
		return m.GetChannelByUsersFn(ctx, u1, u2)
	}
	return nil, nil
}
func (m *MockDMRepo) GetChannelByID(ctx context.Context, id string) (*models.DMChannel, error) {
	if m.GetChannelByIDFn != nil {
		return m.GetChannelByIDFn(ctx, id)
	}
	return nil, nil
}
func (m *MockDMRepo) ListChannels(_ context.Context, _ string) ([]models.DMChannelWithUser, error) {
	return nil, nil
}
func (m *MockDMRepo) CreateChannel(_ context.Context, _ *models.DMChannel) error { return nil }
func (m *MockDMRepo) UpdateChannelStatus(ctx context.Context, channelID, status string) error {
	if m.UpdateChannelStatusFn != nil {
		return m.UpdateChannelStatusFn(ctx, channelID, status)
	}
	return nil
}
func (m *MockDMRepo) SetInitiatedBy(ctx context.Context, channelID, userID string) error {
	if m.SetInitiatedByFn != nil {
		return m.SetInitiatedByFn(ctx, channelID, userID)
	}
	return nil
}
func (m *MockDMRepo) CountMessagesBySender(ctx context.Context, channelID, userID string) (int, error) {
	if m.CountMessagesBySenderFn != nil {
		return m.CountMessagesBySenderFn(ctx, channelID, userID)
	}
	return 0, nil
}
func (m *MockDMRepo) DeleteChannel(_ context.Context, _ string) error       { return nil }
func (m *MockDMRepo) SetE2EEEnabled(_ context.Context, _ string, _ bool) error { return nil }

func (m *MockDMRepo) GetMessages(_ context.Context, _ string, _ string, _ int) ([]models.DMMessage, error) {
	return nil, nil
}
func (m *MockDMRepo) GetMessageByID(ctx context.Context, id string) (*models.DMMessage, error) {
	if m.GetMessageByIDFn != nil {
		return m.GetMessageByIDFn(ctx, id)
	}
	return nil, nil
}
func (m *MockDMRepo) CreateMessage(ctx context.Context, msg *models.DMMessage) error {
	if m.CreateMessageFn != nil {
		return m.CreateMessageFn(ctx, msg)
	}
	return nil
}
func (m *MockDMRepo) UpdateMessage(ctx context.Context, id string, req *models.UpdateDMMessageRequest) error {
	if m.UpdateMessageFn != nil {
		return m.UpdateMessageFn(ctx, id, req)
	}
	return nil
}
func (m *MockDMRepo) DeleteMessage(ctx context.Context, id string) error {
	if m.DeleteMessageFn != nil {
		return m.DeleteMessageFn(ctx, id)
	}
	return nil
}

func (m *MockDMRepo) ToggleReaction(_ context.Context, _, _, _ string) (bool, error) {
	return false, nil
}
func (m *MockDMRepo) GetReactionsByMessageID(_ context.Context, _ string) ([]models.ReactionGroup, error) {
	return nil, nil
}
func (m *MockDMRepo) GetReactionsByMessageIDs(_ context.Context, _ []string) (map[string][]models.ReactionGroup, error) {
	return nil, nil
}

func (m *MockDMRepo) PinMessage(_ context.Context, _ string) error   { return nil }
func (m *MockDMRepo) UnpinMessage(_ context.Context, _ string) error { return nil }
func (m *MockDMRepo) GetPinnedMessages(_ context.Context, _ string) ([]models.DMMessage, error) {
	return nil, nil
}

func (m *MockDMRepo) CreateAttachment(_ context.Context, _ *models.DMAttachment) error { return nil }
func (m *MockDMRepo) GetAttachmentsByMessageIDs(_ context.Context, _ []string) (map[string][]models.DMAttachment, error) {
	return nil, nil
}
func (m *MockDMRepo) GetAttachmentByFileURL(_ context.Context, _ string) (*models.DMAttachment, error) {
	return nil, nil
}

func (m *MockDMRepo) SearchMessages(_ context.Context, _ string, _ string, _, _ int) ([]models.DMMessage, int, error) {
	return nil, 0, nil
}

// ─── BlockChecker / FriendshipChecker / DMSettingsUnhider mocks ───

type MockBlockChecker struct {
	IsBlockedFn func(ctx context.Context, a, b string) (bool, error)
}

func (m *MockBlockChecker) IsBlocked(ctx context.Context, a, b string) (bool, error) {
	if m.IsBlockedFn != nil {
		return m.IsBlockedFn(ctx, a, b)
	}
	return false, nil
}

type MockFriendshipChecker struct {
	AreFriendsFn func(ctx context.Context, a, b string) (bool, error)
}

func (m *MockFriendshipChecker) AreFriends(ctx context.Context, a, b string) (bool, error) {
	if m.AreFriendsFn != nil {
		return m.AreFriendsFn(ctx, a, b)
	}
	return false, nil
}

// MockDMSettingsUnhider is a no-op stub. dm_message calls this on send;
// tests either accept the no-op or capture calls if they need to.
type MockDMSettingsUnhider struct {
	UnhideForNewMessageFn func(ctx context.Context, userID, channelID string) error
}

func (m *MockDMSettingsUnhider) UnhideForNewMessage(ctx context.Context, userID, channelID string) error {
	if m.UnhideForNewMessageFn != nil {
		return m.UnhideForNewMessageFn(ctx, userID, channelID)
	}
	return nil
}
