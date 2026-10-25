package repository

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
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

func (r *sqliteDMReadRepo) MarkUnreadFrom(ctx context.Context, userID, channelID, messageID string) (int, error) {
	query := `
		INSERT INTO dm_reads (user_id, dm_channel_id, last_read_message_id, last_read_at, unread_count)
		SELECT ?, m.dm_channel_id,
		       (SELECT p.id FROM dm_messages p WHERE p.dm_channel_id=m.dm_channel_id
		        AND (p.created_at < m.created_at OR (p.created_at=m.created_at AND p.id < m.id))
		        ORDER BY p.created_at DESC,p.id DESC LIMIT 1),
		       datetime('now'),
		       (SELECT COUNT(*) FROM dm_messages u WHERE u.dm_channel_id=m.dm_channel_id AND u.user_id != ?
		        AND (u.created_at > m.created_at OR (u.created_at=m.created_at AND u.id >= m.id)))
		FROM dm_messages m WHERE m.id=? AND m.dm_channel_id=?
		ON CONFLICT(user_id, dm_channel_id) DO UPDATE SET
		  last_read_message_id=excluded.last_read_message_id,
		  last_read_at=excluded.last_read_at,
		  unread_count=excluded.unread_count`
	result, err := r.db.ExecContext(ctx, query, userID, userID, messageID, channelID)
	if err != nil {
		return 0, fmt.Errorf("failed to mark DM unread: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("failed to inspect DM mark unread: %w", err)
	}
	if rows == 0 {
		return 0, pkg.ErrNotFound
	}
	var count int
	if err := r.db.QueryRowContext(ctx, `SELECT unread_count FROM dm_reads WHERE user_id=? AND dm_channel_id=?`, userID, channelID).Scan(&count); err != nil {
		return 0, fmt.Errorf("failed to read DM unread count: %w", err)
	}
	return count, nil
}

// IncrementUnread — a missing row starts at 1, an existing row is bumped.
// last_read_at on the INSERT branch is only the NOT NULL default being
// satisfied; it does not mean the user read anything.
func (r *sqliteDMReadRepo) IncrementUnread(ctx context.Context, userID, channelID string) error {
	query := `
		INSERT INTO dm_reads (user_id, dm_channel_id, last_read_message_id, last_read_at, unread_count)
		VALUES (?, ?, NULL, datetime('now'), 1)
		ON CONFLICT(user_id, dm_channel_id)
		DO UPDATE SET unread_count = dm_reads.unread_count + 1`

	if _, err := r.db.ExecContext(ctx, query, userID, channelID); err != nil {
		return fmt.Errorf("failed to increment DM unread count: %w", err)
	}
	return nil
}
