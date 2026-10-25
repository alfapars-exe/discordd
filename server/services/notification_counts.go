package services

import (
	"context"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

type notificationSummaryReader interface {
	CountUnreadSummary(context.Context, string) (models.NotificationUnreadCounts, error)
}

// Legacy test/adaptor repositories retain their existing count contract.
// Production repositories supply the two aggregates atomically.
func NotificationUnreadSummary(ctx context.Context, repo repository.NotificationRepository, userID string) (models.NotificationUnreadCounts, error) {
	if source, ok := repo.(notificationSummaryReader); ok {
		return source.CountUnreadSummary(ctx, userID)
	}
	n, err := repo.CountUnread(ctx, userID)
	return models.NotificationUnreadCounts{UnreadCount: n, BadgeUnreadCount: n}, err
}

func (s *notificationService) CountUnreadSummary(ctx context.Context, userID string) (models.NotificationUnreadCounts, error) {
	return NotificationUnreadSummary(ctx, s.repo, userID)
}
