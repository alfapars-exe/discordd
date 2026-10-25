package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// MockNotificationRepo satisfies repository.NotificationRepository. Every
// method is nil-safe (no Fn set = no-op success) so services whose
// notification writes are best-effort side effects need no setup.
type MockNotificationRepo struct {
	CreateFn                func(ctx context.Context, n *models.Notification) error
	ListFn                  func(ctx context.Context, userID, beforeID string, unreadOnly bool, limit int) ([]models.Notification, error)
	MarkReadFn              func(ctx context.Context, userID, id string) (bool, error)
	MarkAllReadFn           func(ctx context.Context, userID string) (int64, error)
	CountUnreadFn           func(ctx context.Context, userID string) (int, error)
	DeleteByMessageIDFn     func(ctx context.Context, messageID string) error
	DeleteByChannelIDFn     func(ctx context.Context, channelID string) error
	MarkFriendRequestReadFn func(ctx context.Context, userID, actorID string) ([]string, error)
	MarkDMRequestReadFn     func(ctx context.Context, userID, dmChannelID string) ([]string, error)
}

func (m *MockNotificationRepo) DeleteByChannelID(ctx context.Context, channelID string) error {
	if m.DeleteByChannelIDFn != nil {
		return m.DeleteByChannelIDFn(ctx, channelID)
	}
	return nil
}
func (m *MockNotificationRepo) MarkFriendRequestRead(ctx context.Context, userID, actorID string) ([]string, error) {
	if m.MarkFriendRequestReadFn != nil {
		return m.MarkFriendRequestReadFn(ctx, userID, actorID)
	}
	return []string{}, nil
}
func (m *MockNotificationRepo) MarkDMRequestRead(ctx context.Context, userID, dmChannelID string) ([]string, error) {
	if m.MarkDMRequestReadFn != nil {
		return m.MarkDMRequestReadFn(ctx, userID, dmChannelID)
	}
	return []string{}, nil
}

func (m *MockNotificationRepo) Create(ctx context.Context, n *models.Notification) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, n)
	}
	return nil
}
func (m *MockNotificationRepo) List(ctx context.Context, userID, beforeID string, unreadOnly bool, limit int) ([]models.Notification, error) {
	if m.ListFn != nil {
		return m.ListFn(ctx, userID, beforeID, unreadOnly, limit)
	}
	return []models.Notification{}, nil
}
func (m *MockNotificationRepo) MarkRead(ctx context.Context, userID, id string) (bool, error) {
	if m.MarkReadFn != nil {
		return m.MarkReadFn(ctx, userID, id)
	}
	return true, nil
}
func (m *MockNotificationRepo) MarkAllRead(ctx context.Context, userID string) (int64, error) {
	if m.MarkAllReadFn != nil {
		return m.MarkAllReadFn(ctx, userID)
	}
	return 0, nil
}
func (m *MockNotificationRepo) CountUnread(ctx context.Context, userID string) (int, error) {
	if m.CountUnreadFn != nil {
		return m.CountUnreadFn(ctx, userID)
	}
	return 0, nil
}
func (m *MockNotificationRepo) DeleteByMessageID(ctx context.Context, messageID string) error {
	if m.DeleteByMessageIDFn != nil {
		return m.DeleteByMessageIDFn(ctx, messageID)
	}
	return nil
}

// MockDMReadRepo satisfies repository.DMReadRepository.
type MockDMReadRepo struct {
	MarkReadFn        func(ctx context.Context, userID, channelID string, messageID *string) error
	MarkUnreadFromFn  func(ctx context.Context, userID, channelID, messageID string) (int, error)
	IncrementUnreadFn func(ctx context.Context, userID, channelID string) error
}

func (m *MockDMReadRepo) MarkUnreadFrom(ctx context.Context, userID, channelID, messageID string) (int, error) {
	if m.MarkUnreadFromFn != nil {
		return m.MarkUnreadFromFn(ctx, userID, channelID, messageID)
	}
	return 0, nil
}

func (m *MockDMReadRepo) MarkRead(ctx context.Context, userID, channelID string, messageID *string) error {
	if m.MarkReadFn != nil {
		return m.MarkReadFn(ctx, userID, channelID, messageID)
	}
	return nil
}
func (m *MockDMReadRepo) IncrementUnread(ctx context.Context, userID, channelID string) error {
	if m.IncrementUnreadFn != nil {
		return m.IncrementUnreadFn(ctx, userID, channelID)
	}
	return nil
}
