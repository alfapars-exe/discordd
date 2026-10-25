package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// NotificationRepository is data access for the notifications table
// (migration 082).
type NotificationRepository interface {
	// Create inserts n, assigning n.ID (generateID) and filling n.CreatedAt
	// from the DB default. An empty Payload is stored as '{}'.
	Create(ctx context.Context, n *models.Notification) error
	// CreateDMMessageIfAbsent stores body-free accepted-DM metadata once per source message.
	CreateDMMessageIfAbsent(ctx context.Context, n *models.Notification) (bool, error)
	// MarkDMMessagesRead acknowledges only this recipient/conversation through an exact source cursor.
	// A nil cursor captures the latest committed source in the caller's serialized DM transaction.
	MarkDMMessagesRead(ctx context.Context, userID, channelID string, messageID *string) ([]string, error)
	// List returns userID's notifications newest-first (created_at DESC,
	// id DESC), at most limit rows, LEFT JOINing the actor's public view.
	// beforeID is a keyset cursor: only rows strictly older than that
	// notification are returned. unreadOnly restricts to read_at IS NULL.
	List(ctx context.Context, userID, beforeID string, unreadOnly bool, limit int) ([]models.Notification, error)
	// MarkRead sets read_at (idempotent) on one notification the user owns.
	// Returns false when no row matched — not found OR not owned, which
	// callers deliberately do not distinguish.
	MarkRead(ctx context.Context, userID, id string) (bool, error)
	// MarkAllRead sets read_at on every unread notification of userID and
	// returns how many rows changed.
	MarkAllRead(ctx context.Context, userID string) (int64, error)
	CountUnread(ctx context.Context, userID string) (int, error)
	// DeleteByMessageID removes every notification pointing at a deleted
	// channel message (best-effort cleanup from the message delete paths).
	DeleteByMessageID(ctx context.Context, messageID string) error
	// DeleteByChannelID removes every notification scoped to a deleted
	// channel (best-effort cleanup from channelService.Delete).
	DeleteByChannelID(ctx context.Context, channelID string) error
	// MarkFriendRequestRead marks userID's unread friend_request rows from
	// actorID as read and returns the ids it changed (empty when none).
	// Called when the request is accepted, declined or cancelled so the
	// inbox entry does not keep offering an action that no longer exists.
	MarkFriendRequestRead(ctx context.Context, userID, actorID string) ([]string, error)
	// MarkDMRequestRead is the dm_request counterpart, keyed by dm_channel_id.
	MarkDMRequestRead(ctx context.Context, userID, dmChannelID string) ([]string, error)
}
