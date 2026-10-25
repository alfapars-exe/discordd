package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteReadStateRepo struct {
	db database.TxQuerier
}

func (r *sqliteReadStateRepo) PrepareMessageDeletion(ctx context.Context, messageID string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE channel_reads SET
	  unread_count=CASE WHEN unread_count>0 AND user_id != (SELECT user_id FROM messages WHERE id=?)
	    AND (last_read_message_id IS NULL OR EXISTS (
	      SELECT 1 FROM messages deleted JOIN messages anchor ON anchor.id=channel_reads.last_read_message_id
	      WHERE deleted.id=? AND (deleted.created_at>anchor.created_at OR (deleted.created_at=anchor.created_at AND deleted.id>anchor.id))))
	    THEN unread_count-1 ELSE unread_count END,
	  last_read_message_id=CASE WHEN last_read_message_id=? THEN (
	    SELECT previous.id FROM messages previous JOIN messages deleted ON deleted.id=?
	    WHERE previous.channel_id=deleted.channel_id AND
	      (previous.created_at<deleted.created_at OR (previous.created_at=deleted.created_at AND previous.id<deleted.id))
	    ORDER BY previous.created_at DESC,previous.id DESC LIMIT 1)
	    ELSE last_read_message_id END
	  WHERE channel_id=(SELECT channel_id FROM messages WHERE id=?)`, messageID, messageID, messageID, messageID, messageID)
	if err != nil {
		return fmt.Errorf("failed to preserve read state before message deletion: %w", err)
	}
	return nil
}

func NewSQLiteReadStateRepo(db database.TxQuerier) ReadStateRepository {
	return &sqliteReadStateRepo{db: db}
}

func (r *sqliteReadStateRepo) Upsert(ctx context.Context, userID, channelID, messageID string) error {
	// Mark-as-read path: reset unread_count to 0 alongside watermark update.
	query := `
		INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, last_read_at, unread_count)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP, 0)
		ON CONFLICT(user_id, channel_id)
		DO UPDATE SET last_read_message_id = excluded.last_read_message_id,
		              last_read_at = excluded.last_read_at,
		              unread_count = 0`

	_, err := r.db.ExecContext(ctx, query, userID, channelID, messageID)
	if err != nil {
		return fmt.Errorf("failed to upsert read state: %w", err)
	}
	return nil
}

// MarkUnreadFrom atomically rewinds the per-user cursor to the message before
// messageID and recomputes the denormalized unread count from authoritative
// message rows. INSERT ... SELECT also verifies the anchor belongs to channelID.
func (r *sqliteReadStateRepo) MarkUnreadFrom(ctx context.Context, userID, channelID, messageID string) (int, error) {
	query := `
		INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, last_read_at, unread_count)
		SELECT ?, m.channel_id,
		       (SELECT p.id FROM messages p WHERE p.channel_id=m.channel_id
		        AND (p.created_at < m.created_at OR (p.created_at=m.created_at AND p.id < m.id))
		        ORDER BY p.created_at DESC,p.id DESC LIMIT 1),
		       CURRENT_TIMESTAMP,
		       (SELECT COUNT(*) FROM messages u WHERE u.channel_id=m.channel_id AND u.user_id != ?
		        AND (u.created_at > m.created_at OR (u.created_at=m.created_at AND u.id >= m.id)))
		FROM messages m WHERE m.id=? AND m.channel_id=?
		ON CONFLICT(user_id, channel_id) DO UPDATE SET
		  last_read_message_id=excluded.last_read_message_id,
		  last_read_at=excluded.last_read_at,
		  unread_count=excluded.unread_count`
	result, err := r.db.ExecContext(ctx, query, userID, userID, messageID, channelID)
	if err != nil {
		return 0, fmt.Errorf("failed to mark unread: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("failed to inspect mark unread: %w", err)
	}
	if rows == 0 {
		return 0, pkg.ErrNotFound
	}
	var count int
	if err := r.db.QueryRowContext(ctx, `SELECT unread_count FROM channel_reads WHERE user_id=? AND channel_id=?`, userID, channelID).Scan(&count); err != nil {
		return 0, fmt.Errorf("failed to read unread count: %w", err)
	}
	return count, nil
}

// IncrementUnreadCounts bumps unread_count for every existing channel_reads
// row in this channel except the message author's.
func (r *sqliteReadStateRepo) IncrementUnreadCounts(ctx context.Context, channelID, excludeUserID string) error {
	query := `
		UPDATE channel_reads
		SET unread_count = unread_count + 1
		WHERE channel_id = ? AND user_id != ?`

	_, err := r.db.ExecContext(ctx, query, channelID, excludeUserID)
	if err != nil {
		return fmt.Errorf("failed to increment unread counts: %w", err)
	}
	return nil
}

// DecrementUnreadForDeleted lowers unread_count by 1 on every channel_reads row
// whose owner had the deleted message counted as unread. CASE guard keeps the
// counter from going negative if state is ever out of sync.
func (r *sqliteReadStateRepo) DecrementUnreadForDeleted(ctx context.Context, channelID, authorID string, deletedAt time.Time) error {
	query := `
		UPDATE channel_reads
		SET unread_count = CASE WHEN unread_count > 0 THEN unread_count - 1 ELSE 0 END
		WHERE channel_id = ?
		  AND user_id != ?
		  AND (
		      last_read_message_id IS NULL
		      OR ? > (SELECT created_at FROM messages WHERE id = last_read_message_id)
		  )`

	_, err := r.db.ExecContext(ctx, query, channelID, authorID, deletedAt)
	if err != nil {
		return fmt.Errorf("failed to decrement unread counts on delete: %w", err)
	}
	return nil
}

// GetUnreadCounts returns per-channel unread counts for a user in a server.
// Excludes the user's own messages from the count.
//
// Hybrid query: reads the denormalized `unread_count` column when a
// channel_reads row exists (hot path — a single indexed lookup per channel),
// and falls back to COUNT(*) for channels the user has never opened.
func (r *sqliteReadStateRepo) GetUnreadCounts(ctx context.Context, userID, serverID string) ([]models.UnreadInfo, error) {
	query := `
		SELECT id, unread_count, mention_count, oldest_unread_message_id FROM (
			SELECT c.id,
			       CASE WHEN cr.user_id IS NOT NULL
			            THEN cr.unread_count
			            ELSE (SELECT COUNT(*) FROM messages m
			                  WHERE m.channel_id = c.id
			                    AND m.user_id != ?)
			       END as unread_count,
			       (SELECT COUNT(*) FROM messages mm
			        WHERE mm.channel_id=c.id AND mm.user_id != ?
			          AND (cr.user_id IS NULL OR cr.last_read_message_id IS NULL
			               OR mm.created_at > anchor.created_at
			               OR (mm.created_at=anchor.created_at AND mm.id > anchor.id))
			          AND (EXISTS (SELECT 1 FROM message_mentions direct
			                       WHERE direct.message_id=mm.id AND direct.user_id=?)
			               OR EXISTS (SELECT 1 FROM message_role_mentions rm
			                          JOIN roles role ON role.id=rm.role_id AND role.server_id=c.server_id
			                          WHERE rm.message_id=mm.id AND
		                          (role.is_default=1 OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.role_id=role.id AND ur.user_id=?))))) as mention_count,
		       (SELECT first_unread.id FROM messages first_unread
		        WHERE first_unread.channel_id=c.id AND first_unread.user_id != ?
		          AND (cr.user_id IS NULL OR cr.last_read_message_id IS NULL OR anchor.id IS NULL
		               OR first_unread.created_at > anchor.created_at
		               OR (first_unread.created_at=anchor.created_at AND first_unread.id > anchor.id))
		        ORDER BY first_unread.created_at ASC, first_unread.id ASC LIMIT 1) as oldest_unread_message_id
			FROM channels c
			LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = ?
			LEFT JOIN messages anchor ON anchor.id=cr.last_read_message_id AND anchor.channel_id=c.id
			WHERE c.type IN ('text','voice') AND c.server_id = ?
		) WHERE unread_count > 0`

	rows, err := r.db.QueryContext(ctx, query, userID, userID, userID, userID, userID, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get unread counts: %w", err)
	}
	defer rows.Close()

	var unreads []models.UnreadInfo
	for rows.Next() {
		var info models.UnreadInfo
		var oldestUnread sql.NullString
		if err := rows.Scan(&info.ChannelID, &info.UnreadCount, &info.MentionCount, &oldestUnread); err != nil {
			return nil, fmt.Errorf("failed to scan unread info: %w", err)
		}
		if oldestUnread.Valid {
			info.OldestUnreadMessageID = &oldestUnread.String
		}
		unreads = append(unreads, info)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating unread rows: %w", err)
	}

	if unreads == nil {
		unreads = []models.UnreadInfo{}
	}

	return unreads, nil
}

// MarkAllRead marks all message-bearing text and voice channels in a server as read for the user.
// Channels with no messages are skipped (INNER JOIN). Resets unread_count to 0.
func (r *sqliteReadStateRepo) MarkAllRead(ctx context.Context, userID, serverID string) error {
	query := `
		INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, last_read_at, unread_count)
		SELECT ?, c.id, latest.id, CURRENT_TIMESTAMP, 0
		FROM channels c
		INNER JOIN (
			SELECT channel_id, id
			FROM messages m1
			WHERE m1.created_at = (
				SELECT MAX(m2.created_at) FROM messages m2 WHERE m2.channel_id = m1.channel_id
			)
		) latest ON latest.channel_id = c.id
		WHERE c.server_id = ? AND c.type IN ('text','voice')
		ON CONFLICT(user_id, channel_id)
		DO UPDATE SET last_read_message_id = excluded.last_read_message_id,
		              last_read_at = excluded.last_read_at,
		              unread_count = 0`

	_, err := r.db.ExecContext(ctx, query, userID, serverID)
	if err != nil {
		return fmt.Errorf("failed to mark all channels as read: %w", err)
	}
	return nil
}
