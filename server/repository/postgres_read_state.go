package repository

import (
	"context"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"time"
)

type postgresReadStateRepo struct{ db database.TxQuerier }

func NewPostgresReadStateRepo(db database.TxQuerier) ReadStateRepository {
	return &postgresReadStateRepo{db}
}
func (r *postgresReadStateRepo) IncrementUnreadCounts(context.Context, string, string) error {
	return nil
}
func (r *postgresReadStateRepo) DecrementUnreadForDeleted(context.Context, string, string, time.Time) error {
	return nil
}

// A durable numeric watermark survives deletion without rewriting every reader.
func (r *postgresReadStateRepo) PrepareMessageDeletion(context.Context, string) error { return nil }
func (r *postgresReadStateRepo) Upsert(ctx context.Context, user, channel, message string) error {
	result, err := r.db.ExecContext(ctx, `INSERT INTO channel_reads(user_id,channel_id,last_read_message_id,last_read_source_sequence,last_read_at,unread_count)
 SELECT ?,channel_id,id,source_sequence,CURRENT_TIMESTAMP,0 FROM messages WHERE id=? AND channel_id=?
 ON CONFLICT(user_id,channel_id) DO UPDATE SET last_read_message_id=CASE WHEN excluded.last_read_source_sequence>=channel_reads.last_read_source_sequence THEN excluded.last_read_message_id ELSE channel_reads.last_read_message_id END,last_read_source_sequence=GREATEST(channel_reads.last_read_source_sequence,excluded.last_read_source_sequence),last_read_at=CURRENT_TIMESTAMP,unread_count=0`, user, message, channel)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n == 0 {
		return pkg.ErrNotFound
	}
	return err
}
func (r *postgresReadStateRepo) MarkUnreadFrom(ctx context.Context, user, channel, message string) (int, error) {
	result, err := r.db.ExecContext(ctx, `INSERT INTO channel_reads(user_id,channel_id,last_read_message_id,last_read_source_sequence,last_read_at,unread_count)
 SELECT ?,m.channel_id,(SELECT id FROM messages p WHERE p.channel_id=m.channel_id AND p.source_sequence<m.source_sequence ORDER BY source_sequence DESC LIMIT 1),m.source_sequence-1,CURRENT_TIMESTAMP,0 FROM messages m WHERE m.id=? AND m.channel_id=?
 ON CONFLICT(user_id,channel_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id,last_read_source_sequence=excluded.last_read_source_sequence,last_read_at=CURRENT_TIMESTAMP,unread_count=0`, user, message, channel)
	if err != nil {
		return 0, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if n == 0 {
		return 0, pkg.ErrNotFound
	}
	var count int
	err = r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages m JOIN channel_reads r ON r.channel_id=m.channel_id AND r.user_id=? WHERE m.channel_id=? AND m.user_id<>? AND m.source_sequence>r.last_read_source_sequence`, user, channel, user).Scan(&count)
	return count, err
}
func (r *postgresReadStateRepo) MarkAllRead(ctx context.Context, user, server string) error {
	_, err := r.db.ExecContext(ctx, `INSERT INTO channel_reads(user_id,channel_id,last_read_message_id,last_read_source_sequence,last_read_at,unread_count)
 SELECT ?,c.id,(SELECT id FROM messages WHERE channel_id=c.id ORDER BY source_sequence DESC LIMIT 1),c.last_source_sequence,CURRENT_TIMESTAMP,0 FROM channels c WHERE c.server_id=? AND c.type IN ('text','voice')
 ON CONFLICT(user_id,channel_id) DO UPDATE SET last_read_message_id=CASE WHEN excluded.last_read_source_sequence>=channel_reads.last_read_source_sequence THEN excluded.last_read_message_id ELSE channel_reads.last_read_message_id END,last_read_source_sequence=GREATEST(channel_reads.last_read_source_sequence,excluded.last_read_source_sequence),last_read_at=CURRENT_TIMESTAMP,unread_count=0`, user, server)
	return err
}
func (r *postgresReadStateRepo) GetUnreadCounts(ctx context.Context, user, server string) ([]models.UnreadInfo, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT c.id,COUNT(m.id),COUNT(m.id) FILTER(WHERE EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.user_id=?) OR EXISTS(SELECT 1 FROM message_role_mentions rm JOIN roles role ON role.id=rm.role_id AND role.server_id=c.server_id WHERE rm.message_id=m.id AND (role.is_default=1 OR EXISTS(SELECT 1 FROM user_roles ur WHERE ur.role_id=role.id AND ur.user_id=?)))),(ARRAY_AGG(m.id ORDER BY m.source_sequence))[1]
 FROM channels c LEFT JOIN channel_reads r ON r.channel_id=c.id AND r.user_id=?
 JOIN messages m ON m.channel_id=c.id AND m.source_sequence>COALESCE(r.last_read_source_sequence,0) AND m.user_id<>?
 WHERE c.server_id=? AND c.type IN ('text','voice') GROUP BY c.id`, user, user, user, user, server)
	if err != nil {
		return nil, fmt.Errorf("get channel unread counts: %w", err)
	}
	defer rows.Close()
	out := []models.UnreadInfo{}
	for rows.Next() {
		var info models.UnreadInfo
		if err = rows.Scan(&info.ChannelID, &info.UnreadCount, &info.MentionCount, &info.OldestUnreadMessageID); err != nil {
			return nil, err
		}
		out = append(out, info)
	}
	return out, rows.Err()
}
