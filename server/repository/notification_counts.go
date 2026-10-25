package repository

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
)

// Count both aggregates from one snapshot; paginated inbox rows cannot supply
// a correct subtraction. The source writer owns this canonical JSON value.
func (r *sqliteNotificationRepo) CountUnreadSummary(ctx context.Context, userID string) (models.NotificationUnreadCounts, error) {
	var counts models.NotificationUnreadCounts
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(SUM(CASE WHEN kind='system' AND actor_id IS NOT NULL AND dm_channel_id IS NOT NULL AND message_id IS NOT NULL AND server_id IS NULL AND channel_id IS NULL AND payload=? THEN 0 ELSE 1 END),0) FROM notifications WHERE user_id=? AND read_at IS NULL`, `{"action":"incoming_message","source":"dm"}`, userID).Scan(&counts.UnreadCount, &counts.BadgeUnreadCount)
	if err != nil {
		return counts, fmt.Errorf("count notification aggregates: %w", err)
	}
	return counts, nil
}
