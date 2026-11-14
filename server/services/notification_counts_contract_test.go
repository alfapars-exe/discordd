package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"testing"
)

type summaryContractRepo struct {
	repository.NotificationRepository
	ctx  context.Context
	user string
	fail error
}

func (s *summaryContractRepo) CountUnread(context.Context, string) (int, error) {
	panic("aggregate must not fall back to legacy count")
}
func (s *summaryContractRepo) CountUnreadSummary(ctx context.Context, user string) (models.NotificationUnreadCounts, error) {
	s.ctx, s.user = ctx, user
	return models.NotificationUnreadCounts{UnreadCount: 19, BadgeUnreadCount: 3}, s.fail
}
func TestNotificationSummaryRetainsDistinctCountsAndErrors(t *testing.T) {
	sentinel := errors.New("summary unavailable")
	for _, failure := range []error{nil, sentinel} {
		repo := &summaryContractRepo{fail: failure}
		ctx, cancel := context.WithCancel(context.Background())
		got, err := NotificationUnreadSummary(ctx, repo, "owner")
		cancel()
		if !errors.Is(err, failure) || repo.ctx != ctx || repo.user != "owner" || got.UnreadCount != 19 || got.BadgeUnreadCount != 3 {
			t.Fatalf("summary=%+v err=%v scope=%s", got, err, repo.user)
		}
	}
}
