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
	const query = `SELECT COUNT(*),COALESCE(SUM(CASE WHEN kind='system' AND actor_id IS NOT NULL AND message_id IS NOT NULL AND server_id IS NULL AND channel_id IS NULL AND ((dm_channel_id IS NOT NULL AND group_dm_channel_id IS NULL AND payload=?) OR (group_dm_channel_id IS NOT NULL AND dm_channel_id IS NULL AND payload=?)) THEN 0 ELSE 1 END),0) FROM notifications n WHERE user_id=? AND read_at IS NULL AND (group_dm_channel_id IS NULL OR EXISTS(SELECT 1 FROM group_dm_members gm JOIN group_dm_channels gc ON gc.id=gm.group_id JOIN group_dm_messages src ON src.group_id=gm.group_id AND src.id=n.message_id WHERE gm.group_id=n.group_dm_channel_id AND gm.user_id=n.user_id))`
	err := r.db.QueryRowContext(ctx, query, `{"action":"incoming_message","source":"dm"}`, groupIncomingMessagePayload, userID).Scan(&counts.UnreadCount, &counts.BadgeUnreadCount)
	if err != nil {
		return counts, fmt.Errorf("count notification aggregates: %w", err)
	}
	return counts, nil
}
