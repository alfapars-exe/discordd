package repository

import "context"

// DMReadRepository is data access for dm_reads (migration 081) — the DM
// counterpart of ReadStateRepository, keyed by (user_id, dm_channel_id).
type DMReadRepository interface {
	// MarkRead acknowledges through a validated source, retaining a monotonic
	// watermark and counting later incoming messages. Nil captures the latest
	// source; an empty conversation never erases an existing watermark.
	MarkRead(ctx context.Context, userID, channelID string, messageID *string) error
	MarkUnreadFrom(ctx context.Context, userID, channelID, messageID string) (int, error)
	// IncrementUnread bumps unread_count by one for userID on channelID,
	// creating the row (unread_count = 1) when none exists yet. Called for
	// the OTHER participant inside the DM send transaction.
	IncrementUnread(ctx context.Context, userID, channelID string) error
}
