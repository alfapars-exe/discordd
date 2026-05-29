package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteAttachmentRepo struct {
	db database.TxQuerier
}

func NewSQLiteAttachmentRepo(db database.TxQuerier) AttachmentRepository {
	return &sqliteAttachmentRepo{db: db}
}

// scanAttachment scans one attachments row in the column order shared by the
// attachment list queries (GetByMessageID, GetByMessageIDs).
func scanAttachment(rows *sql.Rows) (models.Attachment, error) {
	var a models.Attachment
	err := rows.Scan(
		&a.ID, &a.MessageID, &a.Filename, &a.FileURL, &a.FileSize, &a.MimeType, &a.CreatedAt,
	)
	return a, err
}

func (r *sqliteAttachmentRepo) Create(ctx context.Context, attachment *models.Attachment) error {
	query := `
		INSERT INTO attachments (id, message_id, filename, file_url, file_size, mime_type)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		attachment.MessageID,
		attachment.Filename,
		attachment.FileURL,
		attachment.FileSize,
		attachment.MimeType,
	).Scan(&attachment.ID, &attachment.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create attachment: %w", err)
	}

	return nil
}

func (r *sqliteAttachmentRepo) GetByMessageID(ctx context.Context, messageID string) ([]models.Attachment, error) {
	query := `
		SELECT id, message_id, filename, file_url, file_size, mime_type, created_at
		FROM attachments WHERE message_id = ? ORDER BY created_at ASC`

	rows, err := r.db.QueryContext(ctx, query, messageID)
	if err != nil {
		return nil, fmt.Errorf("failed to get attachments by message: %w", err)
	}
	return scanRows(rows, "attachment", scanAttachment)
}

// GetByMessageIDs batch-loads attachments for multiple messages (avoids N+1).
func (r *sqliteAttachmentRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) ([]models.Attachment, error) {
	if len(messageIDs) == 0 {
		return nil, nil
	}

	placeholders := strings.Repeat("?,", len(messageIDs))
	placeholders = placeholders[:len(placeholders)-1]

	query := fmt.Sprintf(`
		SELECT id, message_id, filename, file_url, file_size, mime_type, created_at
		FROM attachments WHERE message_id IN (%s) ORDER BY created_at ASC`, placeholders)

	args := make([]any, len(messageIDs))
	for i, id := range messageIDs {
		args[i] = id
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get attachments by message ids: %w", err)
	}
	return scanRows(rows, "attachment", scanAttachment)
}

// GetByFileURL resolves a /api/uploads/{name} download URL back to its
// attachment row. The auth-gated download handler uses the returned
// message_id to verify the requester has access to the conversation
// that owns the file.
func (r *sqliteAttachmentRepo) GetByFileURL(ctx context.Context, fileURL string) (*models.Attachment, error) {
	query := `SELECT id, message_id, filename, file_url, file_size, mime_type, created_at
		FROM attachments WHERE file_url = ? LIMIT 1`
	var a models.Attachment
	err := r.db.QueryRowContext(ctx, query, fileURL).Scan(
		&a.ID, &a.MessageID, &a.Filename, &a.FileURL, &a.FileSize, &a.MimeType, &a.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, pkg.ErrNotFound
		}
		return nil, fmt.Errorf("failed to get attachment by file_url: %w", err)
	}
	return &a, nil
}

func (r *sqliteAttachmentRepo) Delete(ctx context.Context, id string) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM attachments WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete attachment: %w", err)
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
