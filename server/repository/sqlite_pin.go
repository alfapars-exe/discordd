package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqlitePinRepo struct {
	db database.TxQuerier
}

func NewSQLitePinRepo(db database.TxQuerier) PinRepository {
	return &sqlitePinRepo{db: db}
}

// scanPin scans one pinned-messages row (3-way JOIN: pinned_messages ->
// messages -> users) into a PinnedMessageWithDetails, attaching the message,
// its author (nullable via LEFT JOIN), an empty attachments slice, and the
// pinning user (also nullable).
func scanPin(rows *sql.Rows) (models.PinnedMessageWithDetails, error) {
	var pin models.PinnedMessageWithDetails
	var msg models.Message
	var author models.PublicUser
	var authorID sql.NullString
	var authorCreatedAt sql.NullTime
	var pinnedByUser models.PublicUser
	var pinnedByID, pinnedByStatus sql.NullString

	if err := rows.Scan(
		&pin.ID, &pin.MessageID, &pin.ChannelID, &pin.PinnedBy, &pin.CreatedAt,
		&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
		&authorID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.Status, &author.CustomStatus, &authorCreatedAt,
		&pinnedByID, &pinnedByUser.Username, &pinnedByUser.DisplayName, &pinnedByUser.AvatarURL, &pinnedByStatus,
	); err != nil {
		return pin, err
	}

	if authorID.Valid {
		author.ID = authorID.String
		if authorCreatedAt.Valid {
			author.CreatedAt = authorCreatedAt.Time
		}
		msg.Author = &author
	}
	msg.Attachments = []models.Attachment{} // empty slice, not null
	pin.Message = &msg

	if pinnedByID.Valid {
		pinnedByUser.ID = pinnedByID.String
		if pinnedByStatus.Valid {
			pinnedByUser.Status = models.UserStatus(pinnedByStatus.String)
		}
		pin.PinnedByUser = &pinnedByUser
	}

	return pin, nil
}

// GetByChannelID returns all pinned messages with message and author details.
// 3-way JOIN: pinned_messages -> messages -> users.
func (r *sqlitePinRepo) GetByChannelID(ctx context.Context, channelID string) ([]models.PinnedMessageWithDetails, error) {
	query := `
		SELECT p.id, p.message_id, p.channel_id, p.pinned_by, p.created_at,
		       m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.created_at,
		       pb.id, pb.username, pb.display_name, pb.avatar_url, pb.status
		FROM pinned_messages p
		LEFT JOIN messages m ON p.message_id = m.id
		LEFT JOIN users u ON m.user_id = u.id
		LEFT JOIN users pb ON p.pinned_by = pb.id
		WHERE p.channel_id = ?
		ORDER BY p.created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get pinned messages: %w", err)
	}

	pins, err := scanRows(rows, "pinned message", scanPin)
	if err != nil {
		return nil, err
	}

	if pins == nil {
		pins = []models.PinnedMessageWithDetails{}
	}

	return pins, nil
}

// Pin pins a message. Returns ErrAlreadyExists if already pinned (UNIQUE constraint).
func (r *sqlitePinRepo) Pin(ctx context.Context, pin *models.PinnedMessage) error {
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to pin message: %w", err)
	}
	pin.ID = id

	query := `
		INSERT INTO pinned_messages (id, message_id, channel_id, pinned_by)
		VALUES (?, ?, ?, ?)`

	if _, err := r.db.ExecContext(ctx, query,
		pin.ID,
		pin.MessageID,
		pin.ChannelID,
		pin.PinnedBy,
	); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint") {
			return fmt.Errorf("%w: message is already pinned", pkg.ErrAlreadyExists)
		}
		return fmt.Errorf("failed to pin message: %w", err)
	}

	// Best-effort read-back of the DB-side default created_at (RETURNING avoided
	// for Turso/Hrana safety — see sqlite_user.go Create).
	_ = r.db.QueryRowContext(ctx, "SELECT created_at FROM pinned_messages WHERE id = ?", pin.ID).Scan(&pin.CreatedAt)

	return nil
}

func (r *sqlitePinRepo) Unpin(ctx context.Context, messageID string) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM pinned_messages WHERE message_id = ?`, messageID)
	if err != nil {
		return fmt.Errorf("failed to unpin message: %w", err)
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

func (r *sqlitePinRepo) IsPinned(ctx context.Context, messageID string) (bool, error) {
	var count int
	err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pinned_messages WHERE message_id = ?`, messageID,
	).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check pin status: %w", err)
	}
	return count > 0, nil
}

// CountByChannelID returns the pin count for a channel. Used to enforce per-channel pin limits.
func (r *sqlitePinRepo) CountByChannelID(ctx context.Context, channelID string) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pinned_messages WHERE channel_id = ?`, channelID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count pinned messages: %w", err)
	}
	return count, nil
}
