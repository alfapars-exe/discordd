package repository

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/database"
)

type sqliteDMReadRepo struct {
	db database.TxQuerier
}

func NewSQLiteDMReadRepo(db database.TxQuerier) DMReadRepository {
	return &sqliteDMReadRepo{db: db}
}

// MarkRead — mirrors sqliteReadStateRepo.Upsert. The COALESCE keeps the
// stored watermark when the caller sent no message_id, so an empty-body
// read never regresses last_read_message_id to NULL.
func (r *sqliteDMReadRepo) MarkRead(ctx context.Context, userID, channelID string, messageID *string) error {
	query := `
		INSERT INTO dm_reads (user_id, dm_channel_id, last_read_message_id, last_read_at, unread_count)
		VALUES (?, ?, ?, datetime('now'), 0)
		ON CONFLICT(user_id, dm_channel_id)
		DO UPDATE SET last_read_message_id = COALESCE(excluded.last_read_message_id, dm_reads.last_read_message_id),
		              last_read_at = excluded.last_read_at,
		              unread_count = 0`

	if _, err := r.db.ExecContext(ctx, query, userID, channelID, messageID); err != nil {
		return fmt.Errorf("failed to mark DM as read: %w", err)
	}
	return nil
}

// IncrementUnread — a missing row starts at 1, an existing row is bumped.
// last_read_at on the INSERT branch is only the NOT NULL default being
// satisfied; it does not mean the user read anything.
func (r *sqliteDMReadRepo) IncrementUnread(ctx context.Context, userID, channelID string) error {
	query := `
		INSERT INTO dm_reads (user_id, dm_channel_id, last_read_message_id, last_read_at, unread_count)
		VALUES (?, ?, NULL, datetime('now'), 1)
		ON CONFLICT(user_id, dm_channel_id)
		DO UPDATE SET unread_count = unread_count + 1`

	if _, err := r.db.ExecContext(ctx, query, userID, channelID); err != nil {
		return fmt.Errorf("failed to increment DM unread count: %w", err)
	}
	return nil
}
