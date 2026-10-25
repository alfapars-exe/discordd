package repository

// DM channel operations for sqliteDMRepo.

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/argeinfina/hichat/database"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// GetChannelByUsers returns the DM channel between two users.
// user1ID and user2ID must be pre-sorted (enforced by service layer).
func (r *sqliteDMRepo) GetChannelByUsers(ctx context.Context, user1ID, user2ID string) (*models.DMChannel, error) {
	var ch models.DMChannel
	var lastMsgAt sql.NullTime
	var initiatedBy sql.NullString
	err := r.db.QueryRowContext(ctx,
		"SELECT id, user1_id, user2_id, e2ee_enabled, status, initiated_by, created_at, last_message_at FROM dm_channels WHERE user1_id = ? AND user2_id = ?",
		user1ID, user2ID,
	).Scan(&ch.ID, &ch.User1ID, &ch.User2ID, &ch.E2EEEnabled, &ch.Status, &initiatedBy, &ch.CreatedAt, &lastMsgAt)

	if err == sql.ErrNoRows {
		return nil, nil // no channel exists
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get DM channel: %w", err)
	}
	if lastMsgAt.Valid {
		ch.LastMessageAt = &lastMsgAt.Time
	}
	if initiatedBy.Valid {
		ch.InitiatedBy = &initiatedBy.String
	}
	return &ch, nil
}

func (r *sqliteDMRepo) GetChannelByID(ctx context.Context, id string) (*models.DMChannel, error) {
	var ch models.DMChannel
	var lastMsgAt sql.NullTime
	var initiatedBy sql.NullString
	err := r.db.QueryRowContext(ctx,
		"SELECT id, user1_id, user2_id, e2ee_enabled, status, initiated_by, created_at, last_message_at FROM dm_channels WHERE id = ?",
		id,
	).Scan(&ch.ID, &ch.User1ID, &ch.User2ID, &ch.E2EEEnabled, &ch.Status, &initiatedBy, &ch.CreatedAt, &lastMsgAt)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: DM channel not found", pkg.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get DM channel: %w", err)
	}
	if lastMsgAt.Valid {
		ch.LastMessageAt = &lastMsgAt.Time
	}
	if initiatedBy.Valid {
		ch.InitiatedBy = &initiatedBy.String
	}
	return &ch, nil
}

// ListChannels returns a user's DM channels with the other user's info.
// Joins user_dm_settings to filter hidden channels and include pin/mute state,
// dm_reads for the caller's unread counter (0 without a row), and the
// channel's newest dm_messages row as the sidebar preview (NULL columns when
// the channel has no messages). The preview's content is dropped for E2EE
// messages so ciphertext never reaches the list payload.
// Sorted: pinned first (by activity), then unpinned by activity.
func (r *sqliteDMRepo) ListChannels(ctx context.Context, userID string) ([]models.DMChannelWithUser, error) {
	query := `
		SELECT dc.id, dc.e2ee_enabled, dc.status, dc.initiated_by, dc.created_at, dc.last_message_at,
			u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.created_at,
			COALESCE(ds.is_pinned, 0),
			CASE WHEN ds.muted_until IS NOT NULL AND ds.muted_until > datetime('now') THEN 1 ELSE 0 END,
			COALESCE(dr.unread_count, 0),
			(SELECT unread.id FROM dm_messages unread
			 WHERE unread.dm_channel_id=dc.id AND unread.user_id != ? AND COALESCE(dr.unread_count,0)>0
           AND unread.source_sequence>COALESCE(dr.last_read_source_sequence,0)
             ORDER BY unread.source_sequence ASC LIMIT 1),
			lm.id, lm.user_id, lm.content, lm.encryption_version, lm.created_at, lm.source_sequence
		FROM dm_channels dc
		JOIN users u ON u.id = CASE
			WHEN dc.user1_id = ? THEN dc.user2_id
			ELSE dc.user1_id
		END
		LEFT JOIN user_dm_settings ds ON ds.user_id = ? AND ds.dm_channel_id = dc.id
		LEFT JOIN dm_reads dr ON dr.user_id = ? AND dr.dm_channel_id = dc.id
		LEFT JOIN dm_messages lm ON lm.id = (
			SELECT id FROM dm_messages WHERE dm_channel_id = dc.id
			ORDER BY source_sequence DESC LIMIT 1)
		WHERE (dc.user1_id = ? OR dc.user2_id = ?)
		  AND COALESCE(ds.is_hidden, 0) = 0
		ORDER BY COALESCE(ds.is_pinned, 0) DESC,
		         COALESCE(dc.last_message_at, dc.created_at) DESC`

	rows, err := r.db.QueryContext(ctx, query, userID, userID, userID, userID, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list DM channels: %w", err)
	}
	defer rows.Close()

	var channels []models.DMChannelWithUser
	for rows.Next() {
		var ch models.DMChannelWithUser
		var user models.PublicUser
		var displayName, avatarURL, initiatedBy, customStatus sql.NullString
		var lastMsgAt, userCreatedAt sql.NullTime
		var isPinned, isMuted int
		var lmID, lmUserID, lmContent sql.NullString
		var oldestUnread sql.NullString
		var lmEncryptionVersion sql.NullInt64
		var lmCreatedAt sql.NullTime
		var lastSequence sql.NullInt64

		if err := rows.Scan(
			&ch.ID, &ch.E2EEEnabled, &ch.Status, &initiatedBy, &ch.CreatedAt, &lastMsgAt,
			&user.ID, &user.Username, &displayName, &avatarURL, &user.Status, &customStatus, &userCreatedAt,
			&isPinned, &isMuted,
			&ch.UnreadCount,
			&oldestUnread,
			&lmID, &lmUserID, &lmContent, &lmEncryptionVersion, &lmCreatedAt, &lastSequence,
		); err != nil {
			return nil, fmt.Errorf("failed to scan DM channel: %w", err)
		}

		if lmID.Valid {
			last := &models.DMLastMessage{
				SourceSequence:    lastSequence.Int64,
				ID:                lmID.String,
				UserID:            lmUserID.String,
				EncryptionVersion: int(lmEncryptionVersion.Int64),
			}
			if lmCreatedAt.Valid {
				last.CreatedAt = lmCreatedAt.Time
			}
			// Plaintext only: an E2EE row's content column is NULL anyway,
			// but the version check makes the "never ciphertext" rule explicit.
			if last.EncryptionVersion == 0 && lmContent.Valid && lmContent.String != "" {
				content := lmContent.String
				last.Content = &content
			}
			ch.LastMessage = last
		}

		if lastMsgAt.Valid {
			ch.LastMessageAt = &lastMsgAt.Time
		}
		if displayName.Valid {
			user.DisplayName = &displayName.String
		}
		if avatarURL.Valid {
			user.AvatarURL = &avatarURL.String
		}
		if customStatus.Valid {
			user.CustomStatus = &customStatus.String
		}
		if userCreatedAt.Valid {
			user.CreatedAt = userCreatedAt.Time
		}
		if initiatedBy.Valid {
			ch.InitiatedBy = &initiatedBy.String
		}

		ch.OtherUser = &user
		if oldestUnread.Valid {
			ch.OldestUnreadMessageID = &oldestUnread.String
		}
		ch.IsPinned = isPinned == 1
		ch.IsMuted = isMuted == 1
		channels = append(channels, ch)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating DM channels: %w", err)
	}

	if channels == nil {
		channels = []models.DMChannelWithUser{}
	}
	return channels, nil
}

func (r *sqliteDMRepo) CreateChannel(ctx context.Context, channel *models.DMChannel) error {
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to create DM channel: %w", err)
	}
	channel.ID = id

	if _, err := r.db.ExecContext(ctx,
		"INSERT INTO dm_channels (id, user1_id, user2_id, status, initiated_by) VALUES (?, ?, ?, ?, ?)",
		channel.ID, channel.User1ID, channel.User2ID, channel.Status, channel.InitiatedBy,
	); err != nil {
		return fmt.Errorf("failed to create DM channel: %w", err)
	}

	// Best-effort read-back of the DB-side default created_at (RETURNING avoided
	// for Turso/Hrana safety — see sqlite_user.go Create). last_message_at is
	// NULL for a brand-new channel, so LastMessageAt stays nil.
	_ = r.db.QueryRowContext(ctx, "SELECT created_at FROM dm_channels WHERE id = ?", channel.ID).Scan(&channel.CreatedAt)
	return nil
}

func (r *sqliteDMRepo) UpdateChannelStatus(ctx context.Context, channelID, status string) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE dm_channels SET status = ? WHERE id = ?",
		status, channelID,
	)
	if err != nil {
		return fmt.Errorf("failed to update DM channel status: %w", err)
	}
	return nil
}

type PendingDMAccepter interface {
	AcceptPendingUnblocked(context.Context, string) (bool, error)
}

// Lock before checking blocks: PostgreSQL READ COMMITTED obtains a fresh
// snapshot for the second statement after waiting for a blocking transaction.
func (r *sqliteDMRepo) AcceptPendingUnblocked(ctx context.Context, channelID string) (bool, error) {
	raw := database.RawDB(r.db)
	if raw == nil {
		return false, fmt.Errorf("%w: DM acceptance requires database connection", pkg.ErrInternal)
	}
	changed := false
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE dm_channels SET status = status WHERE id = ?`, channelID); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE dm_channels SET status = 'accepted'
	 WHERE id = ? AND status = 'pending' AND NOT EXISTS (
	 SELECT 1 FROM friendships f WHERE f.status = 'blocked' AND
	 ((f.user_id = dm_channels.user1_id AND f.friend_id = dm_channels.user2_id)
	 OR (f.user_id = dm_channels.user2_id AND f.friend_id = dm_channels.user1_id)))`, channelID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		changed = count == 1
		return err
	})
	return err == nil && changed, err
}

func (r *sqliteDMRepo) SetInitiatedBy(ctx context.Context, channelID, userID string) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE dm_channels SET initiated_by = ? WHERE id = ?",
		userID, channelID,
	)
	if err != nil {
		return fmt.Errorf("failed to set initiated_by: %w", err)
	}
	return nil
}

// TransitionToPending sets status=pending and initiated_by=userID in one
// UPDATE — see the DMRepository interface doc comment for why this replaced
// two separate calls (UpdateChannelStatus + SetInitiatedBy) at its one call
// site in dm_message.go.
func (r *sqliteDMRepo) TransitionToPending(ctx context.Context, channelID, userID string) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE dm_channels SET status = ?, initiated_by = ? WHERE id = ?",
		models.DMStatusPending, userID, channelID,
	)
	if err != nil {
		return fmt.Errorf("failed to transition DM channel to pending: %w", err)
	}
	return nil
}

func (r *sqliteDMRepo) CountMessagesBySender(ctx context.Context, channelID, userID string) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM dm_messages WHERE dm_channel_id = ? AND user_id = ?",
		channelID, userID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count messages: %w", err)
	}
	return count, nil
}

func (r *sqliteDMRepo) DeleteChannel(ctx context.Context, channelID string) error {
	// dm_attachments.dm_message_id declares ON DELETE CASCADE, but the
	// production libSQL/Turso connection never turns the foreign_keys
	// PRAGMA on (see database/integrity.go), so that constraint never
	// fires there. Must run BEFORE the dm_messages delete below — the
	// subquery identifies rows by joining through dm_messages, which
	// disappears the moment that statement runs (cascade-ordering rule
	// documented in repository/server_cascade.go:76-77).
	if _, err := r.db.ExecContext(ctx, `DELETE FROM dm_attachments WHERE dm_message_id IN (
		SELECT id FROM dm_messages WHERE dm_channel_id = ?)`, channelID); err != nil {
		return fmt.Errorf("failed to delete DM attachments: %w", err)
	}
	// saved_messages (migration 083) — same rule and same ordering as
	// dm_attachments above: the subquery joins through dm_messages.
	if _, err := r.db.ExecContext(ctx, `DELETE FROM saved_messages WHERE dm_message_id IN (
		SELECT id FROM dm_messages WHERE dm_channel_id = ?)`, channelID); err != nil {
		return fmt.Errorf("failed to delete saved references for DM channel: %w", err)
	}
	_, err := r.db.ExecContext(ctx, "DELETE FROM dm_messages WHERE dm_channel_id = ?", channelID)
	if err != nil {
		return fmt.Errorf("failed to delete DM messages: %w", err)
	}
	// dm_reads / notifications declare ON DELETE CASCADE to dm_channels
	// (migrations 081/082) but, as above, the production connection never
	// enforces it — delete them explicitly, before the parent row.
	if _, err := r.db.ExecContext(ctx, "DELETE FROM dm_reads WHERE dm_channel_id = ?", channelID); err != nil {
		return fmt.Errorf("failed to delete DM read states: %w", err)
	}
	if _, err := r.db.ExecContext(ctx, "DELETE FROM notifications WHERE dm_channel_id = ?", channelID); err != nil {
		return fmt.Errorf("failed to delete DM notifications: %w", err)
	}
	_, err = r.db.ExecContext(ctx, "DELETE FROM dm_channels WHERE id = ?", channelID)
	if err != nil {
		return fmt.Errorf("failed to delete DM channel: %w", err)
	}
	return nil
}

func (r *sqliteDMRepo) SetE2EEEnabled(ctx context.Context, channelID string, enabled bool) error {
	result, err := r.db.ExecContext(ctx,
		"UPDATE dm_channels SET e2ee_enabled = ? WHERE id = ?",
		enabled, channelID,
	)
	if err != nil {
		return fmt.Errorf("failed to update DM E2EE: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}
	return nil
}
