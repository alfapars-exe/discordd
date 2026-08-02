package repository

// DM attachment operations for sqliteDMRepo.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func (r *sqliteDMRepo) CreateAttachment(ctx context.Context, attachment *models.DMAttachment) error {
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to create DM attachment: %w", err)
	}
	attachment.ID = id

	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO dm_attachments (id, dm_message_id, filename, file_url, file_size, mime_type)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		attachment.ID, attachment.DMMessageID, attachment.Filename, attachment.FileURL, attachment.FileSize, attachment.MimeType,
	); err != nil {
		return fmt.Errorf("failed to create DM attachment: %w", err)
	}

	// Best-effort read-back of the DB-side default created_at (see sqlite_user.go).
	_ = r.db.QueryRowContext(ctx, "SELECT created_at FROM dm_attachments WHERE id = ?", attachment.ID).Scan(&attachment.CreatedAt)
	return nil
}

// GetAttachmentsByMessageIDs batch-loads attachments for multiple DM messages (avoids N+1).
func (r *sqliteDMRepo) GetAttachmentsByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.DMAttachment, error) {
	if len(messageIDs) == 0 {
		return make(map[string][]models.DMAttachment), nil
	}

	placeholders := strings.Repeat("?,", len(messageIDs))
	placeholders = placeholders[:len(placeholders)-1]

	query := fmt.Sprintf(`
		SELECT id, dm_message_id, filename, file_url, file_size, mime_type, created_at
		FROM dm_attachments
		WHERE dm_message_id IN (%s)
		ORDER BY created_at ASC`, placeholders)

	args := make([]any, len(messageIDs))
	for i, id := range messageIDs {
		args[i] = id
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get DM attachments by message ids: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]models.DMAttachment)
	for rows.Next() {
		var a models.DMAttachment
		if err := rows.Scan(
			&a.ID, &a.DMMessageID, &a.Filename, &a.FileURL, &a.FileSize, &a.MimeType, &a.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan DM attachment row: %w", err)
		}
		result[a.DMMessageID] = append(result[a.DMMessageID], a)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate DM attachment rows: %w", err)
	}

	return result, nil
}

// GetAttachmentFileURLsByChannelID returns every attachment file_url for
// messages in the given DM channel. Used by DeclineRequest to clean up
// on-disk files before the channel row (and, explicitly, its messages and
// attachments — see DeleteChannel) is deleted.
func (r *sqliteDMRepo) GetAttachmentFileURLsByChannelID(ctx context.Context, channelID string) ([]string, error) {
	query := `SELECT file_url FROM dm_attachments WHERE dm_message_id IN (
		SELECT id FROM dm_messages WHERE dm_channel_id = ?)`

	rows, err := r.db.QueryContext(ctx, query, channelID)
	if err != nil {
		return nil, fmt.Errorf("get DM attachment file urls by channel id: %w", err)
	}
	defer rows.Close()

	var urls []string
	for rows.Next() {
		var url string
		if err := rows.Scan(&url); err != nil {
			return nil, fmt.Errorf("scan DM attachment file url: %w", err)
		}
		urls = append(urls, url)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate DM attachment file url rows: %w", err)
	}

	return urls, nil
}

// GetAttachmentByFileURL resolves a /api/uploads/{name} download URL back
// to its DM attachment row. The auth-gated download handler uses the
// returned dm_message_id to look up the parent DM channel and verify
// participant access.
func (r *sqliteDMRepo) GetAttachmentByFileURL(ctx context.Context, fileURL string) (*models.DMAttachment, error) {
	query := `SELECT id, dm_message_id, filename, file_url, file_size, mime_type, created_at
		FROM dm_attachments WHERE file_url = ? LIMIT 1`
	var a models.DMAttachment
	err := r.db.QueryRowContext(ctx, query, fileURL).Scan(
		&a.ID, &a.DMMessageID, &a.Filename, &a.FileURL, &a.FileSize, &a.MimeType, &a.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, pkg.ErrNotFound
		}
		return nil, fmt.Errorf("get DM attachment by file_url: %w", err)
	}
	return &a, nil
}
