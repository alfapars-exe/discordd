package services

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"
)

// Source persistence lives in the group transaction, not in this postcommit
// push. The concrete repository serializes this callback against revocation.
func (s *groupDMService) deliverGroupIncomingNotifications(ctx context.Context, m *models.GroupDMMessage) {
	if s.notificationDelivery == nil {
		return
	}
	if err := s.notificationDelivery.DeliverCommittedGroupNotifications(ctx, m.GroupID, m.ID, func(n *models.Notification) { broadcastNotificationCreate(s.hub, n) }); err != nil {
		groupDMLogger.Error("committed group inbox push skipped", "group_id", m.GroupID, "err", pkg.ErrText(err))
	}
}

// Source reads/deletes may affect more than the bounded notification WS ID
// budget. Refresh the owned feed; never claim every unrelated row was read.
func (s *groupDMService) refreshGroupInbox(ctx context.Context, userID string) {
	if s.notifications == nil {
		return
	}
	counts, err := NotificationUnreadSummary(ctx, s.notifications, userID)
	if err != nil {
		groupDMLogger.Error("committed group inbox refresh skipped", "user_id", userID, "err", pkg.ErrText(err))
		return
	}
	s.hub.BroadcastToUser(userID, ws.Event{Op: ws.OpNotificationRead, Data: map[string]any{"ids": []string{}, "all": false, "refresh_required": true, "unread_count": counts.UnreadCount, "badge_unread_count": counts.BadgeUnreadCount}})
}
