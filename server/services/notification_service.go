package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var notificationLogger = logx.Component("service.notification")

const (
	// NotificationPageDefault / NotificationPageMax bound GET
	// /api/users/me/notifications?limit — the handler clamps into this range.
	NotificationPageDefault = 20
	NotificationPageMax     = 50
)

// NotificationService is the read/ack side of the inbox. Writers live next
// to the events they describe (message_service Create, dm_message.go
// SendMessage, friendship_service SendRequest) and share
// broadcastNotificationCreate below.
type NotificationService interface {
	List(ctx context.Context, userID, beforeID string, unreadOnly bool, limit int) (*models.NotificationPage, error)
	// MarkRead returns pkg.ErrNotFound when the row does not exist OR is not
	// owned by userID (deliberately indistinguishable).
	MarkRead(ctx context.Context, userID, id string) error
	MarkAllRead(ctx context.Context, userID string) (int64, error)
	CountUnread(ctx context.Context, userID string) (int, error)
}

type notificationService struct {
	repo repository.NotificationRepository
	hub  ws.Broadcaster
}

func NewNotificationService(repo repository.NotificationRepository, hub ws.Broadcaster) NotificationService {
	return &notificationService{repo: repo, hub: hub}
}

func (s *notificationService) List(ctx context.Context, userID, beforeID string, unreadOnly bool, limit int) (*models.NotificationPage, error) {
	// Same clamp as the handler: non-positive → default, oversized → max.
	if limit <= 0 {
		limit = NotificationPageDefault
	}
	if limit > NotificationPageMax {
		limit = NotificationPageMax
	}

	// Fetch limit+1 to determine if more pages exist (same pattern as
	// messageService.GetByChannelID).
	list, err := s.repo.List(ctx, userID, beforeID, unreadOnly, limit+1)
	if err != nil {
		return nil, fmt.Errorf("failed to list notifications: %w", err)
	}
	hasMore := len(list) > limit
	if hasMore {
		list = list[:limit]
	}
	return &models.NotificationPage{Notifications: list, HasMore: hasMore}, nil
}

func (s *notificationService) MarkRead(ctx context.Context, userID, id string) error {
	ok, err := s.repo.MarkRead(ctx, userID, id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: notification not found", pkg.ErrNotFound)
	}

	// The badge count after this ack. A count failure here is logged and
	// skips the push only — the REST call already succeeded and the client
	// re-syncs from GET .../notifications/count.
	unread, err := s.repo.CountUnread(ctx, userID)
	if err != nil {
		notificationLogger.Error("failed to count unread after mark-read", "user_id", userID, "err", pkg.ErrText(err))
		return nil
	}
	s.broadcastRead(userID, []string{id}, false, unread)
	return nil
}

func (s *notificationService) MarkAllRead(ctx context.Context, userID string) (int64, error) {
	marked, err := s.repo.MarkAllRead(ctx, userID)
	if err != nil {
		return 0, err
	}
	// Every unread row was just marked, so the remaining count is 0 by
	// construction — no second query needed.
	s.broadcastRead(userID, []string{}, true, 0)
	return marked, nil
}

func (s *notificationService) CountUnread(ctx context.Context, userID string) (int, error) {
	return s.repo.CountUnread(ctx, userID)
}

func (s *notificationService) broadcastRead(userID string, ids []string, all bool, unread int) {
	broadcastNotificationRead(s.hub, userID, ids, all, unread)
}

// broadcastNotificationRead pushes the notification_read event to the
// reader's own sessions so other open tabs/devices drop the badge too.
// Shared with the request-settling writers below.
func broadcastNotificationRead(hub ws.Broadcaster, userID string, ids []string, all bool, unread int) {
	hub.BroadcastToUser(userID, ws.Event{
		Op: ws.OpNotificationRead,
		Data: map[string]any{
			"ids":          ids,
			"all":          all,
			"unread_count": unread,
		},
	})
}

// settleRequestNotifications is the best-effort tail of a friend/DM request
// being accepted, declined or cancelled: ids/err come straight from the
// repo's MarkFriendRequestRead / MarkDMRequestRead. A repo failure is only
// logged (the request state change already succeeded); when rows were
// actually marked, the recipient gets notification_read with the fresh
// unread count so the stale "accept?" entry drops out of their inbox.
func settleRequestNotifications(ctx context.Context, repo repository.NotificationRepository, hub ws.Broadcaster, userID string, ids []string, err error) {
	if err != nil {
		notificationLogger.Error("failed to mark request notifications as read", "user_id", userID, "err", pkg.ErrText(err))
		return
	}
	if len(ids) == 0 {
		return
	}
	unread, err := repo.CountUnread(ctx, userID)
	if err != nil {
		notificationLogger.Error("failed to count unread after settling request notifications", "user_id", userID, "err", pkg.ErrText(err))
		return
	}
	broadcastNotificationRead(hub, userID, ids, false, unread)
}

// broadcastNotificationCreate pushes a freshly committed notification to
// its target user. Shared by every writer; call it AFTER the owning
// transaction committed so a rollback can never leave a phantom toast.
func broadcastNotificationCreate(hub ws.Broadcaster, n *models.Notification) {
	hub.BroadcastToUser(n.UserID, ws.Event{
		Op:   ws.OpNotificationCreate,
		Data: n,
	})
}
