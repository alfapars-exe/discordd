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
		err := r.db.QueryRowContext(ctx, `SELECT id FROM dm_messages WHERE dm_channel_id=? ORDER BY source_sequence DESC LIMIT 1`, channelID).Scan(&latest)
		if err == nil {
			return r.MarkRead(ctx, userID, channelID, &latest)
		}
		if err != sql.ErrNoRows {
			return err
		}
		_, err = r.db.ExecContext(ctx, `INSERT INTO dm_reads(user_id,dm_channel_id,last_read_at,unread_count) VALUES(?,?,CURRENT_TIMESTAMP,0) ON CONFLICT(user_id,dm_channel_id) DO UPDATE SET last_read_at=excluded.last_read_at,unread_count=0`, userID, channelID)
		return err
	}
	result, err := r.db.ExecContext(ctx, `INSERT INTO dm_reads(user_id,dm_channel_id,last_read_message_id,last_read_source_sequence,last_read_at,unread_count)
 SELECT ?,m.dm_channel_id,
 CASE WHEN m.source_sequence>=COALESCE(dr.last_read_source_sequence,0) THEN m.id ELSE dr.last_read_message_id END,
 CASE WHEN m.source_sequence>=COALESCE(dr.last_read_source_sequence,0) THEN m.source_sequence ELSE dr.last_read_source_sequence END,
 CURRENT_TIMESTAMP,(SELECT COUNT(*) FROM dm_messages u WHERE u.dm_channel_id=m.dm_channel_id AND u.user_id<>? AND u.source_sequence>(CASE WHEN m.source_sequence>=COALESCE(dr.last_read_source_sequence,0) THEN m.source_sequence ELSE dr.last_read_source_sequence END))
 FROM dm_messages m LEFT JOIN dm_reads dr ON dr.dm_channel_id=m.dm_channel_id AND dr.user_id=? WHERE m.id=? AND m.dm_channel_id=?
 ON CONFLICT(user_id,dm_channel_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id,last_read_source_sequence=excluded.last_read_source_sequence,last_read_at=excluded.last_read_at,unread_count=excluded.unread_count`, userID, userID, userID, *messageID, channelID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return pkg.ErrNotFound
	}
	return nil
}

func (r *sqliteDMReadRepo) MarkUnreadFrom(ctx context.Context, userID, channelID, messageID string) (int, error) {
	result, err := r.db.ExecContext(ctx, `INSERT INTO dm_reads(user_id,dm_channel_id,last_read_message_id,last_read_source_sequence,last_read_at,unread_count)
 SELECT ?,m.dm_channel_id,(SELECT p.id FROM dm_messages p WHERE p.dm_channel_id=m.dm_channel_id AND p.source_sequence<m.source_sequence ORDER BY p.source_sequence DESC LIMIT 1),m.source_sequence-1,CURRENT_TIMESTAMP,
 (SELECT COUNT(*) FROM dm_messages u WHERE u.dm_channel_id=m.dm_channel_id AND u.user_id<>? AND u.source_sequence>=m.source_sequence)
 FROM dm_messages m WHERE m.id=? AND m.dm_channel_id=?
 ON CONFLICT(user_id,dm_channel_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id,last_read_source_sequence=excluded.last_read_source_sequence,last_read_at=excluded.last_read_at,unread_count=excluded.unread_count`, userID, userID, messageID, channelID)
	if err != nil {
		return 0, fmt.Errorf("mark DM unread: %w", err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if n != 1 {
		return 0, pkg.ErrNotFound
	}
	var count int
	err = r.db.QueryRowContext(ctx, `SELECT unread_count FROM dm_reads WHERE user_id=? AND dm_channel_id=?`, userID, channelID).Scan(&count)
	return count, err
}

// IncrementUnread — a missing row starts at 1, an existing row is bumped.
// last_read_at on the INSERT branch is only the NOT NULL default being
// satisfied; it does not mean the user read anything.
func (r *sqliteDMReadRepo) IncrementUnread(ctx context.Context, userID, channelID string) error {
	query := `
		INSERT INTO dm_reads (user_id, dm_channel_id, last_read_message_id, last_read_at, unread_count)
		VALUES (?, ?, NULL, CURRENT_TIMESTAMP, 1)
		ON CONFLICT(user_id, dm_channel_id)
		DO UPDATE SET unread_count = dm_reads.unread_count + 1`

	if _, err := r.db.ExecContext(ctx, query, userID, channelID); err != nil {
		return fmt.Errorf("failed to increment DM unread count: %w", err)
	}
	return nil
}
