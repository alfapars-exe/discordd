package services

import (
	"context"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

// NotificationUnreadSummary preserves the shared call surface while requiring
// authoritative aggregates from every notification repository.
func NotificationUnreadSummary(ctx context.Context, repo repository.NotificationRepository, userID string) (models.NotificationUnreadCounts, error) {
	return repo.CountUnreadSummary(ctx, userID)
}

func (s *notificationService) CountUnreadSummary(ctx context.Context, userID string) (models.NotificationUnreadCounts, error) {
	return NotificationUnreadSummary(ctx, s.repo, userID)
}
