package repository

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

const maxDataExportBytes = 50 << 20

type sqliteDataExportRepo struct{ db database.TxQuerier }

func NewSQLiteDataExportRepo(db database.TxQuerier) DataExportRepository {
	return &sqliteDataExportRepo{db: db}
}

func exportID() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (r *sqliteDataExportRepo) Create(ctx context.Context, user *models.User) (*models.DataExportJob, error) {
	if user == nil {
		return nil, pkg.ErrUnauthorized
	}
	_, _ = r.db.ExecContext(ctx, `DELETE FROM data_exports WHERE expires_at <= CURRENT_TIMESTAMP`)

	type rowMap map[string]any
	query := func(q string, args ...any) ([]rowMap, error) {
		rows, err := r.db.QueryContext(ctx, q, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		cols, err := rows.Columns()
		if err != nil {
			return nil, err
		}
		out := make([]rowMap, 0)
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				return nil, err
			}
			m := rowMap{}
			for i, v := range vals {
				if b, ok := v.([]byte); ok {
					v = string(b)
				}
				m[cols[i]] = v
			}
			out = append(out, m)
		}
		return out, rows.Err()
	}

	queries := []struct{ name, sql string }{
		{"preferences", `SELECT data, updated_at FROM user_preferences WHERE user_id=?`},
		{"server_memberships", `SELECT server_id, joined_at FROM server_members WHERE user_id=?`},
		{"authored_server_events", `SELECT id, server_id, name, description, starts_at, ends_at, channel_id, status, version, created_at, updated_at FROM server_events WHERE creator_id=? ORDER BY created_at, id`},
		{"server_event_rsvps", `SELECT event_id, interested_at, updated_at FROM server_event_rsvps WHERE user_id=? ORDER BY interested_at, event_id`},
		{"server_event_deliveries", `SELECT event_id, starts_at, delivered_at FROM server_event_deliveries WHERE user_id=? ORDER BY delivered_at, event_id, starts_at`},
		{"friendship_anniversary_decisions", `SELECT friendship_id, anniversary_year, decided_at FROM friendship_anniversary_deliveries WHERE recipient_id=? ORDER BY decided_at, friendship_id, anniversary_year`},
		{"stream_notification_decisions", `SELECT publication_id, decided_at FROM stream_start_deliveries WHERE recipient_id=? ORDER BY decided_at, publication_id`},
		{"friendships", `SELECT id, user_id, friend_id, status, created_at, updated_at, accepted_at FROM friendships WHERE user_id=? OR friend_id=?`},
		{"channel_messages", `SELECT id, channel_id, content, edited_at, created_at, reply_to_id, encryption_version, ciphertext, sender_device_id, e2ee_metadata FROM messages WHERE user_id=? ORDER BY created_at`},
		{"direct_messages", `SELECT id, dm_channel_id, content, edited_at, created_at, reply_to_id, encryption_version, ciphertext, sender_device_id, e2ee_metadata FROM dm_messages WHERE user_id=? ORDER BY created_at`},
		{"notifications", `SELECT id, kind, actor_id, server_id, channel_id, message_id, dm_channel_id, payload, read_at, created_at FROM notifications WHERE user_id=? ORDER BY created_at`},
		{"saved_messages", `SELECT id, message_id, dm_message_id, note, created_at FROM saved_messages WHERE user_id=? ORDER BY created_at`},
		{"spam_decisions", `SELECT source_kind, channel_id, message_id, revision, reasons, status, created_at, updated_at FROM spam_inbox WHERE user_id=? ORDER BY created_at, source_kind, message_id`},
		{"private_media_labels", `SELECT source_kind, channel_id, message_id, revision, fingerprint, label, updated_at FROM private_media_labels WHERE user_id=? ORDER BY updated_at, source_kind, message_id, fingerprint`},
		{"private_notes", `SELECT target_user_id, note, updated_at FROM user_notes WHERE owner_user_id=? ORDER BY updated_at`},
	}
	doc := map[string]any{
		"format": "hichat-personal-data-v1", "exported_at": time.Now().UTC(),
		"account": map[string]any{"id": user.ID, "username": user.Username, "display_name": user.DisplayName, "email": user.Email, "language": user.Language, "created_at": user.CreatedAt},
	}
	for _, item := range queries {
		args := []any{user.ID}
		if item.name == "friendships" {
			args = append(args, user.ID)
		}
		rows, err := query(item.sql, args...)
		if err != nil {
			return nil, fmt.Errorf("export %s: %w", item.name, err)
		}
		doc[item.name] = rows
	}
	payload, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	if len(payload) > maxDataExportBytes {
		return nil, fmt.Errorf("data export too large: %w", pkg.ErrBadRequest)
	}
	id, err := exportID()
	if err != nil {
		return nil, err
	}
	expires := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	if _, err := r.db.ExecContext(ctx, `INSERT INTO data_exports(id,user_id,status,payload,expires_at) VALUES(?,?,'ready',?,?)
		ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,status='ready',payload=excluded.payload,error_code=NULL,created_at=CURRENT_TIMESTAMP,expires_at=excluded.expires_at`, id, user.ID, string(payload), expires); err != nil {
		return nil, err
	}
	return r.Get(ctx, user.ID, id)
}

func (r *sqliteDataExportRepo) Get(ctx context.Context, userID, id string) (*models.DataExportJob, error) {
	var j models.DataExportJob
	err := r.db.QueryRowContext(ctx, `SELECT id,status,error_code,created_at,expires_at FROM data_exports WHERE id=? AND user_id=? AND expires_at>CURRENT_TIMESTAMP`, id, userID).Scan(&j.ID, &j.Status, &j.ErrorCode, &j.CreatedAt, &j.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	return &j, err
}

func (r *sqliteDataExportRepo) Download(ctx context.Context, userID, id string) ([]byte, error) {
	var payload string
	err := r.db.QueryRowContext(ctx, `SELECT payload FROM data_exports WHERE id=? AND user_id=? AND status='ready' AND expires_at>CURRENT_TIMESTAMP`, id, userID).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	return []byte(payload), err
}
