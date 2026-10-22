package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type sqliteNotificationRepo struct {
	db database.TxQuerier
}

func NewSQLiteNotificationRepo(db database.TxQuerier) NotificationRepository {
	return &sqliteNotificationRepo{db: db}
}

func (r *sqliteNotificationRepo) Create(ctx context.Context, n *models.Notification) error {
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to create notification: %w", err)
	}
	n.ID = id

	payload := "{}"
	if len(n.Payload) > 0 {
		payload = string(n.Payload)
	}

	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO notifications (id, user_id, kind, actor_id, server_id, channel_id, message_id, dm_channel_id, payload)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		n.ID, n.UserID, n.Kind, n.ActorID, n.ServerID, n.ChannelID, n.MessageID, n.DMChannelID, payload,
	); err != nil {
		return fmt.Errorf("failed to create notification: %w", err)
	}
	n.Payload = json.RawMessage(payload)

	// Best-effort read-back of the DB-side default created_at (RETURNING
	// avoided for Turso/Hrana safety — see sqlite_user.go Create). The
	// broadcast payload needs it; a failed read-back leaves CreatedAt "".
	var createdAt string
	if err := r.db.QueryRowContext(ctx, "SELECT created_at FROM notifications WHERE id = ?", n.ID).Scan(&createdAt); err == nil {
		n.CreatedAt = dbTextToRFC3339(createdAt)
	}
	return nil
}

// dbTextToRFC3339 converts the table's 'YYYY-MM-DD HH:MM:SS' UTC text into
// RFC3339 ('2006-01-02T15:04:05Z') for the API/WS boundary: the raw form
// parses as LOCAL time on V8 and as NaN on WebKit. Text that does not match
// the expected shape is passed through unchanged rather than dropped.
func dbTextToRFC3339(s string) string {
	t, err := time.Parse("2006-01-02 15:04:05", s)
	if err != nil {
		return s
	}
	return t.UTC().Format(time.RFC3339)
}

// List — keyset pagination in the boolean-expanded form SQLite accepts
// (`a < X OR (a = X AND b < Y)`, no row-value comparison). The cursor
// subquery is scoped to the caller's own rows, so a foreign or unknown
// beforeID makes it NULL, every comparison is NULL and the page is empty —
// another user's id cannot be probed for its timestamp. The cursor
// compares the raw stored column, so the RFC3339 conversion applied to the
// emitted rows does not affect it.
func (r *sqliteNotificationRepo) List(ctx context.Context, userID, beforeID string, unreadOnly bool, limit int) ([]models.Notification, error) {
	query := `
		SELECT n.id, n.user_id, n.kind, n.actor_id, n.server_id, n.channel_id, n.message_id, n.dm_channel_id,
		       n.payload, n.read_at, n.created_at,
		       u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.created_at
		FROM notifications n
		LEFT JOIN users u ON u.id = n.actor_id
		WHERE n.user_id = ?`
	args := []any{userID}

	if unreadOnly {
		query += ` AND n.read_at IS NULL`
	}
	if beforeID != "" {
		query += ` AND (n.created_at < (SELECT created_at FROM notifications WHERE id = ? AND user_id = ?)
		            OR (n.created_at = (SELECT created_at FROM notifications WHERE id = ? AND user_id = ?) AND n.id < ?))`
		args = append(args, beforeID, userID, beforeID, userID, beforeID)
	}
	query += ` ORDER BY n.created_at DESC, n.id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list notifications: %w", err)
	}
	defer rows.Close()

	var list []models.Notification
	for rows.Next() {
		n, err := scanNotificationRow(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, *n)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating notifications: %w", err)
	}
	if list == nil {
		list = []models.Notification{}
	}
	return list, nil
}

// scanNotificationRow — the actor columns come back through NullStrings
// because the users LEFT JOIN yields all-NULL columns for a deleted actor
// (mirrors scanDMMessageRow). Payload that is not valid JSON is replaced by
// '{}' so one corrupt row can never break the page's JSON encoding.
// created_at / read_at leave here as RFC3339 (see dbTextToRFC3339).
func scanNotificationRow(rows *sql.Rows) (*models.Notification, error) {
	var n models.Notification
	var actorID, serverID, channelID, messageID, dmChannelID, readAt sql.NullString
	var payload, createdAt string
	var uID, uUsername, uDisplayName, uAvatarURL, uStatus, uCustomStatus sql.NullString
	var uCreatedAt sql.NullTime

	if err := rows.Scan(
		&n.ID, &n.UserID, &n.Kind, &actorID, &serverID, &channelID, &messageID, &dmChannelID,
		&payload, &readAt, &createdAt,
		&uID, &uUsername, &uDisplayName, &uAvatarURL, &uStatus, &uCustomStatus, &uCreatedAt,
	); err != nil {
		return nil, fmt.Errorf("failed to scan notification: %w", err)
	}

	n.CreatedAt = dbTextToRFC3339(createdAt)
	n.ActorID = nullStringPtr(actorID)
	n.ServerID = nullStringPtr(serverID)
	n.ChannelID = nullStringPtr(channelID)
	n.MessageID = nullStringPtr(messageID)
	n.DMChannelID = nullStringPtr(dmChannelID)
	if readAt.Valid {
		ra := dbTextToRFC3339(readAt.String)
		n.ReadAt = &ra
	}

	if json.Valid([]byte(payload)) {
		n.Payload = json.RawMessage(payload)
	} else {
		n.Payload = json.RawMessage("{}")
	}

	if uID.Valid {
		actor := &models.PublicUser{
			ID:           uID.String,
			Username:     uUsername.String,
			Status:       models.UserStatus(uStatus.String),
			DisplayName:  nullStringPtr(uDisplayName),
			AvatarURL:    nullStringPtr(uAvatarURL),
			CustomStatus: nullStringPtr(uCustomStatus),
		}
		if uCreatedAt.Valid {
			actor.CreatedAt = uCreatedAt.Time
		}
		n.Actor = actor
	}
	return &n, nil
}

func nullStringPtr(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	v := s.String
	return &v
}

// MarkRead — COALESCE keeps the original read_at on a repeat call, and the
// row still counts as matched, so re-reading an already-read notification
// reports true (200) rather than a spurious 404.
func (r *sqliteNotificationRepo) MarkRead(ctx context.Context, userID, id string) (bool, error) {
	result, err := r.db.ExecContext(ctx,
		`UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ? AND user_id = ?`,
		id, userID,
	)
	if err != nil {
		return false, fmt.Errorf("failed to mark notification as read: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("failed to check rows affected: %w", err)
	}
	return affected > 0, nil
}

func (r *sqliteNotificationRepo) MarkAllRead(ctx context.Context, userID string) (int64, error) {
	result, err := r.db.ExecContext(ctx,
		`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`,
		userID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to mark all notifications as read: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("failed to check rows affected: %w", err)
	}
	return affected, nil
}

func (r *sqliteNotificationRepo) CountUnread(ctx context.Context, userID string) (int, error) {
	var n int
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL`, userID,
	).Scan(&n); err != nil {
		return 0, fmt.Errorf("failed to count unread notifications: %w", err)
	}
	return n, nil
}

func (r *sqliteNotificationRepo) DeleteByMessageID(ctx context.Context, messageID string) error {
	if _, err := r.db.ExecContext(ctx, `DELETE FROM notifications WHERE message_id = ?`, messageID); err != nil {
		return fmt.Errorf("failed to delete notifications for message: %w", err)
	}
	return nil
}

func (r *sqliteNotificationRepo) DeleteByChannelID(ctx context.Context, channelID string) error {
	if _, err := r.db.ExecContext(ctx, `DELETE FROM notifications WHERE channel_id = ?`, channelID); err != nil {
		return fmt.Errorf("failed to delete notifications for channel: %w", err)
	}
	return nil
}

// MarkFriendRequestRead matches on (kind, user_id, actor_id) rather than the
// friendship_id inside payload: a plain column predicate needs no JSON1
// function support from the libSQL/Turso side.
func (r *sqliteNotificationRepo) MarkFriendRequestRead(ctx context.Context, userID, actorID string) ([]string, error) {
	return r.markUnreadByRef(ctx,
		`SELECT id FROM notifications WHERE user_id = ? AND kind = 'friend_request' AND actor_id = ? AND read_at IS NULL`,
		userID, actorID)
}

func (r *sqliteNotificationRepo) MarkDMRequestRead(ctx context.Context, userID, dmChannelID string) ([]string, error) {
	return r.markUnreadByRef(ctx,
		`SELECT id FROM notifications WHERE user_id = ? AND kind = 'dm_request' AND dm_channel_id = ? AND read_at IS NULL`,
		userID, dmChannelID)
}

// markUnreadByRef selects the unread ids matching selectQuery, then sets
// read_at on exactly those rows, returning the ids so the caller can push
// a precise notification_read. Two statements, not one UPDATE: callers
// need the ids and RETURNING is avoided for Turso/Hrana safety.
func (r *sqliteNotificationRepo) markUnreadByRef(ctx context.Context, selectQuery string, args ...any) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, selectQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to find request notifications: %w", err)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, fmt.Errorf("failed to scan notification id: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating request notifications: %w", err)
	}
	if len(ids) == 0 {
		return ids, nil
	}

	placeholders := make([]string, len(ids))
	updArgs := make([]any, 0, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		updArgs = append(updArgs, id)
	}
	if _, err := r.db.ExecContext(ctx,
		`UPDATE notifications SET read_at = datetime('now') WHERE read_at IS NULL AND id IN (`+strings.Join(placeholders, ",")+`)`,
		updArgs...,
	); err != nil {
		return nil, fmt.Errorf("failed to mark request notifications as read: %w", err)
	}
	return ids, nil
}
