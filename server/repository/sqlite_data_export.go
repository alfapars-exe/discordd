package repository

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

const maxDataExportBytes = 50 << 20
const defaultMaxTotalExportArchiveBytes int64 = 2 << 30

type DataExportStorageOptions struct {
	UploadDir            string
	ArchiveDir           string
	MaxArchiveBytes      int64
	MaxTotalArchiveBytes int64
}

type sqliteDataExportRepo struct {
	db                   database.TxQuerier
	uploadDir            string
	archiveDir           string
	maxArchiveBytes      int64
	maxTotalArchiveBytes int64
	workerMu             sync.Mutex
	workerRunning        bool
	workerStopping       bool
	workerCtx            context.Context
	workerCancel         context.CancelFunc
	workerDone           chan struct{}
}

func NewSQLiteDataExportRepo(db database.TxQuerier, options ...DataExportStorageOptions) DataExportRepository {
	r := &sqliteDataExportRepo{db: db, maxArchiveBytes: defaultMaxExportArchiveBytes, maxTotalArchiveBytes: defaultMaxTotalExportArchiveBytes}
	if len(options) > 0 {
		r.uploadDir = options[0].UploadDir
		r.archiveDir = options[0].ArchiveDir
		if options[0].MaxArchiveBytes > 0 {
			r.maxArchiveBytes = options[0].MaxArchiveBytes
		}
		if options[0].MaxTotalArchiveBytes > 0 {
			r.maxTotalArchiveBytes = options[0].MaxTotalArchiveBytes
		}
	}
	return r
}

func exportID() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (r *sqliteDataExportRepo) Create(ctx context.Context, user *models.User) (*models.DataExportJob, error) {
	if user == nil || user.ID == "" || user.IsBot {
		return nil, pkg.ErrUnauthorized
	}
	var attachments []exportAttachment

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
		{"game_application_grants", `SELECT bot_user_id AS application_id, messaging_enabled, revision, authorized_at, updated_at, revoked_at FROM application_game_grants WHERE user_id=? ORDER BY bot_user_id`},
		{"server_memberships", `SELECT server_id, joined_at FROM server_members WHERE user_id=?`},
		// Export only the owner's conversation membership and attachments to
		// their own authored messages. Shared-channel access is not ownership of
		// another author's files; neither this list nor the archive embeds keys.
		{"direct_message_memberships", `SELECT id AS dm_channel_id,user1_id,user2_id,e2ee_enabled,status,initiated_by,created_at,last_message_at FROM dm_channels WHERE ? IN (user1_id,user2_id) ORDER BY created_at,id`},
		{"group_memberships", `SELECT g.id AS group_id,g.name,g.icon_url,g.owner_id,g.key_epoch,g.created_at,g.updated_at,m.joined_at,m.is_muted,m.settings_revision FROM group_dm_members m JOIN group_dm_channels g ON g.id=m.group_id WHERE m.user_id=? ORDER BY m.joined_at,g.id`},
		{"channel_attachments", `SELECT a.id,a.message_id,m.channel_id,a.filename,a.file_url,a.file_size,a.mime_type,a.created_at,m.encryption_version FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.user_id=? ORDER BY a.created_at,a.id`},
		{"direct_message_attachments", `SELECT a.id,a.dm_message_id,m.dm_channel_id,a.filename,a.file_url,a.file_size,a.mime_type,a.created_at,m.encryption_version FROM dm_attachments a JOIN dm_messages m ON m.id=a.dm_message_id WHERE m.user_id=? ORDER BY a.created_at,a.id`},
		{"group_attachments", `SELECT a.id,a.group_message_id,m.group_id,a.filename,a.file_url,a.file_size,a.mime_type,a.file_key_index,a.created_at,m.encryption_version FROM group_dm_attachments a JOIN group_dm_messages m ON m.id=a.group_message_id WHERE m.user_id=? ORDER BY a.created_at,a.id`},
		{"authored_server_events", `SELECT id, server_id, name, description, starts_at, ends_at, channel_id, status, version, created_at, updated_at FROM server_events WHERE creator_id=? ORDER BY created_at, id`},
		{"server_event_rsvps", `SELECT event_id, interested_at, updated_at FROM server_event_rsvps WHERE user_id=? ORDER BY interested_at, event_id`},
		{"server_event_deliveries", `SELECT event_id, starts_at, delivered_at FROM server_event_deliveries WHERE user_id=? ORDER BY delivered_at, event_id, starts_at`},
		{"friendship_anniversary_decisions", `SELECT friendship_id, anniversary_year, decided_at FROM friendship_anniversary_deliveries WHERE recipient_id=? ORDER BY decided_at, friendship_id, anniversary_year`},
		{"stream_notification_decisions", `SELECT publication_id, decided_at FROM stream_start_deliveries WHERE recipient_id=? ORDER BY decided_at, publication_id`},
		{"friendships", `SELECT id, user_id, friend_id, status, created_at, updated_at, accepted_at FROM friendships WHERE user_id=? OR friend_id=?`},
		{"channel_messages", `SELECT id, channel_id, content, edited_at, created_at, reply_to_id, encryption_version, ciphertext, sender_device_id, e2ee_metadata FROM messages WHERE user_id=? ORDER BY created_at`},
		{"direct_messages", `SELECT id, dm_channel_id, content, edited_at, created_at, reply_to_id, encryption_version, ciphertext, sender_device_id, e2ee_metadata, application_id, CAST(source_sequence AS TEXT) AS source_sequence FROM dm_messages WHERE user_id=? ORDER BY created_at`},
		{"group_messages", `SELECT id, group_id, content, edited_at, created_at, reply_to_id, encryption_version, ciphertext, sender_device_id, e2ee_metadata, key_epoch, CAST(source_sequence AS TEXT) AS source_sequence FROM group_dm_messages WHERE user_id=? ORDER BY group_id, group_dm_messages.source_sequence`},
		{"notifications", `SELECT id, kind, actor_id, server_id, channel_id, message_id, dm_channel_id, group_dm_channel_id, payload, read_at, created_at FROM notifications WHERE user_id=? ORDER BY created_at`},
		{"saved_messages", `SELECT id, message_id, dm_message_id, note, created_at FROM saved_messages WHERE user_id=? ORDER BY created_at`},
		{"spam_decisions", `SELECT source_kind, channel_id, message_id, revision, reasons, status, created_at, updated_at FROM spam_inbox WHERE user_id=? ORDER BY created_at, source_kind, message_id`},
		{"private_media_labels", `SELECT source_kind, channel_id, message_id, revision, fingerprint, label, updated_at FROM private_media_labels WHERE user_id=? ORDER BY updated_at, source_kind, message_id, fingerprint`},
		{"own_music_operations", `SELECT channel_id, request_id, session_id, expected_revision, created_at FROM music_operation_receipts WHERE actor_id=? ORDER BY created_at, channel_id, request_id`},
		{"private_notes", `SELECT target_user_id, note, updated_at FROM user_notes WHERE owner_user_id=? ORDER BY updated_at`},
	}
	doc := map[string]any{
		"format": "hichat-personal-data-v1", "exported_at": time.Now().UTC(),
		// Explicit owner-only allowlist: do not marshal User itself, even fields
		// currently exposed by its API JSON tags. Administrative/moderation
		// metadata and authentication secrets must never enter this archive.
		"account": map[string]any{
			"id": user.ID, "username": user.Username, "display_name": user.DisplayName,
			"email": user.Email, "language": user.Language, "created_at": user.CreatedAt,
			"avatar_url": user.AvatarURL, "avatar_animated_url": user.AvatarAnimatedURL,
			"banner_url": user.BannerURL, "banner_animated_url": user.BannerAnimatedURL,
			"wallpaper_url": user.WallpaperURL, "bio": user.Bio, "pronouns": user.Pronouns,
			"accent_color": user.AccentColor, "custom_status": user.CustomStatus,
			"status": user.Status, "pref_status": user.PrefStatus,
			"dm_privacy": user.DMPrivacy, "last_seen_at": user.LastSeenAt,
		},
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
		if isExportAttachmentSection(item.name) {
			for _, row := range rows {
				attachment, err := exportAttachmentFromRow(item.name, row)
				if err != nil {
					return nil, fmt.Errorf("export %s: %w", item.name, err)
				}
				attachments = append(attachments, attachment)
				delete(row, "encryption_version")
			}
		}
		doc[item.name] = rows
	}
	music, err := r.ownMusicQueueItems(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	doc["own_music_queue_items"] = music
	payload, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	if len(payload) > maxDataExportBytes {
		return nil, fmt.Errorf("data export too large: %w", pkg.ErrBadRequest)
	}
	attachmentPayload, err := json.Marshal(attachments)
	if err != nil {
		return nil, err
	}
	id, err := exportID()
	if err != nil {
		return nil, err
	}
	attachmentStatus := "none"
	if len(attachments) > 0 {
		if r.uploadDir == "" || r.archiveDir == "" {
			// Preserve the historical metadata export for older constructors that
			// do not configure private binary storage.
			attachmentStatus = "not_configured"
		} else {
			attachmentStatus = "pending"
		}
	}
	expires := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	raw := database.RawDB(r.db)
	if raw == nil {
		return nil, fmt.Errorf("data export requires a transactional database")
	}
	var job *models.DataExportJob
	var supersededID string
	err = database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		// Collect snapshots without the global retirement lock. Publication is
		// serialized and the authenticated identity is rechecked at commit.
		postgres := database.IsPostgres(raw)
		if err := lockMusicIdentityTx(ctx, tx, postgres); err != nil {
			return err
		}
		liveQuery := `SELECT u.token_version FROM users u WHERE u.id=? AND u.is_bot=0 AND u.deleted_at IS NULL AND u.is_platform_banned=0
		 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)`
		if postgres {
			liveQuery += ` FOR UPDATE`
		}
		var tokenVersion int
		if err := tx.QueryRowContext(ctx, liveQuery, user.ID).Scan(&tokenVersion); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return pkg.ErrUnauthorized
			}
			return err
		}
		if tokenVersion != user.TokenVersion {
			return pkg.ErrUnauthorized
		}
		if err := tx.QueryRowContext(ctx, `SELECT id FROM data_exports WHERE user_id=?`, user.ID).Scan(&supersededID); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO data_exports(id,user_id,status,payload,expires_at,attachment_status,attachment_error,attachment_payload) VALUES(?,?,'ready',?,?,?,NULL,?)
		 ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,status='ready',payload=excluded.payload,error_code=NULL,created_at=CURRENT_TIMESTAMP,expires_at=excluded.expires_at,attachment_status=excluded.attachment_status,attachment_error=NULL,attachment_payload=excluded.attachment_payload`, id, user.ID, string(payload), expires, attachmentStatus, string(attachmentPayload)); err != nil {
			return err
		}
		var err error
		job, err = (&sqliteDataExportRepo{db: tx, uploadDir: r.uploadDir, archiveDir: r.archiveDir}).Get(ctx, user.ID, id)
		return err
	})
	if err == nil {
		if supersededID != "" && supersededID != id {
			r.cleanupSupersededArchive(ctx, supersededID)
		}
		if attachmentStatus == "pending" {
			r.kickArchiveWorker()
		}
	}
	return job, err
}

func (r *sqliteDataExportRepo) Get(ctx context.Context, userID, id string) (*models.DataExportJob, error) {
	var j models.DataExportJob
	err := r.db.QueryRowContext(ctx, `SELECT id,status,error_code,created_at,expires_at,attachment_status,attachment_error FROM data_exports WHERE id=? AND user_id=? AND expires_at>CURRENT_TIMESTAMP AND EXISTS(SELECT 1 FROM users u WHERE u.id=data_exports.user_id AND u.is_bot=0 AND u.deleted_at IS NULL AND u.is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL))`, id, userID).Scan(&j.ID, &j.Status, &j.ErrorCode, &j.CreatedAt, &j.ExpiresAt, &j.AttachmentsStatus, &j.AttachmentsError)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if j.AttachmentsStatus == "ready" {
		// Readiness is local to the serving storage namespace. A restored DB
		// or another instance may still have the ready row without this ZIP.
		// Reuse the owner/generation/expiry checks and safe file open used by
		// download; never mutate the global reservation or quota from a local
		// filesystem observation.
		archive, _, openErr := r.DownloadAttachments(ctx, userID, id)
		switch {
		case openErr == nil:
			_ = archive.Close()
			j.AttachmentsReady = true
		case errors.Is(openErr, pkg.ErrNotFound):
			code := "archive_file_unavailable"
			j.AttachmentsError = &code
		default:
			return nil, openErr
		}
	}
	return &j, nil
}

func (r *sqliteDataExportRepo) Download(ctx context.Context, userID, id string) ([]byte, error) {
	var payload string
	err := r.db.QueryRowContext(ctx, `SELECT payload FROM data_exports WHERE id=? AND user_id=? AND status='ready' AND expires_at>CURRENT_TIMESTAMP AND EXISTS(SELECT 1 FROM users u WHERE u.id=data_exports.user_id AND u.is_bot=0 AND u.deleted_at IS NULL AND u.is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL))`, id, userID).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	return []byte(payload), err
}

// Export only owned entries, never shared queue blobs or unknown future fields.
// Go decoding keeps SQLite/PostgreSQL behavior identical; duplicate tracks
// remain distinct entries with their original queue identity and position.
func (r *sqliteDataExportRepo) ownMusicQueueItems(ctx context.Context, owner string) ([]map[string]any, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT s.channel_id,s.server_id,s.queue_json,s.repeat_mode,s.revision,COALESCE(h.session_id,'') FROM music_sessions s LEFT JOIN music_control_heads h ON h.channel_id=s.channel_id ORDER BY s.channel_id`)
	if err != nil {
		return nil, fmt.Errorf("export music queues: %w", err)
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var channelID, serverID, raw, repeatMode, sessionID string
		var revision uint64
		if err := rows.Scan(&channelID, &serverID, &raw, &repeatMode, &revision, &sessionID); err != nil {
			return nil, err
		}
		var tracks []models.MusicTrack
		if err := json.Unmarshal([]byte(raw), &tracks); err != nil {
			return nil, fmt.Errorf("export music queue %s: %w", channelID, err)
		}
		for index, track := range tracks {
			if track.RequestedByUserID == owner {
				items = append(items, map[string]any{"channel_id": channelID, "server_id": serverID, "session_id": sessionID, "revision": revision, "repeat_mode": repeatMode, "queue_index": index, "track": map[string]any{
					"queue_item_id": track.QueueItemID, "video_id": track.VideoID,
					"title": track.Title, "artist": track.Artist, "thumbnail": track.Thumbnail,
					"duration_seconds": track.DurationSeconds, "url": track.URL,
					"requested_by_user_id": track.RequestedByUserID, "requested_by_name": track.RequestedByName,
				}})
			}
		}
	}
	return items, rows.Err()
}
