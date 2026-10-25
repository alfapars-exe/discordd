package repository

import (
	"context"
	"database/sql"
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

// MarkRead retains a monotonic source watermark. A bodyless read captures the
// latest source while the caller holds the shared DM transaction lock.
func (r *sqliteDMReadRepo) MarkRead(ctx context.Context, userID, channelID string, messageID *string) error {
	if messageID == nil {
		var latest string
		err := r.db.QueryRowContext(ctx, `SELECT id FROM dm_messages WHERE dm_channel_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, channelID).Scan(&latest)
		if err == nil {
			return r.MarkRead(ctx, userID, channelID, &latest)
		}
		if err != sql.ErrNoRows {
			return err
		}
	}
	if messageID != nil {
		var exists int
		if err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM dm_messages WHERE id=? AND dm_channel_id=?`, *messageID, channelID).Scan(&exists); err != nil {
			return err
		}
		if exists != 1 {
			return pkg.ErrNotFound
		}
		// Late acknowledgements cannot move an existing read watermark backwards.
		var cursor string
		if err := r.db.QueryRowContext(ctx, `SELECT id FROM dm_messages WHERE dm_channel_id=? AND
		 (id=? OR id=(SELECT last_read_message_id FROM dm_reads WHERE user_id=? AND dm_channel_id=?))
		 ORDER BY created_at DESC,id DESC LIMIT 1`, channelID, *messageID, userID, channelID).Scan(&cursor); err != nil {
			return err
		}
		_, err := r.db.ExecContext(ctx, `INSERT INTO dm_reads(user_id,dm_channel_id,last_read_message_id,last_read_at,unread_count)
		 SELECT ?,m.dm_channel_id,m.id,datetime('now'),
		 (SELECT COUNT(*) FROM dm_messages u WHERE u.dm_channel_id=m.dm_channel_id AND u.user_id!=?
		 AND (u.created_at>m.created_at OR (u.created_at=m.created_at AND u.id>m.id)))
		 FROM dm_messages m WHERE m.id=? AND m.dm_channel_id=?
		 ON CONFLICT(user_id,dm_channel_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id,
		 last_read_at=excluded.last_read_at,unread_count=excluded.unread_count`, userID, userID, cursor, channelID)
		return err
	}
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
