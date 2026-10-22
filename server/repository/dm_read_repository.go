package repository

import "context"

// DMReadRepository is data access for dm_reads (migration 081) — the DM
// counterpart of ReadStateRepository, keyed by (user_id, dm_channel_id).
type DMReadRepository interface {
	// MarkRead upserts the caller's row with unread_count = 0 and a fresh
	// last_read_at. messageID nil keeps the existing last_read_message_id
	// (a body-less POST .../read only clears the counter).
	MarkRead(ctx context.Context, userID, channelID string, messageID *string) error
	// IncrementUnread bumps unread_count by one for userID on channelID,
	// creating the row (unread_count = 1) when none exists yet. Called for
	// the OTHER participant inside the DM send transaction.
	IncrementUnread(ctx context.Context, userID, channelID string) error
}
