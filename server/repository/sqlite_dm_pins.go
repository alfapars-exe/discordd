package repository

// DM pin operations for sqliteDMRepo.

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func (r *sqliteDMRepo) PinMessage(ctx context.Context, messageID string) error {
	result, err := r.db.ExecContext(ctx,
		"UPDATE dm_messages SET is_pinned = 1 WHERE id = ?", messageID,
	)
	if err != nil {
		return fmt.Errorf("failed to pin DM message: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("%w: DM message not found", pkg.ErrNotFound)
	}
	return nil
}

func (r *sqliteDMRepo) UnpinMessage(ctx context.Context, messageID string) error {
	result, err := r.db.ExecContext(ctx,
		"UPDATE dm_messages SET is_pinned = 0 WHERE id = ?", messageID,
	)
	if err != nil {
		return fmt.Errorf("failed to unpin DM message: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("%w: DM message not found", pkg.ErrNotFound)
	}
	return nil
}

func (r *sqliteDMRepo) GetPinnedMessages(ctx context.Context, channelID string) ([]models.DMMessage, error) {
	query := `
		SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       m.reply_to_id, m.is_pinned,
		       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
		       u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.created_at,
		       rm.id, rm.content,
		       ru.id, ru.username, ru.display_name, ru.avatar_url, ru.status, ru.custom_status, ru.created_at
		FROM dm_messages m
		LEFT JOIN users u ON m.user_id = u.id
		LEFT JOIN dm_messages rm ON m.reply_to_id = rm.id
		LEFT JOIN users ru ON rm.user_id = ru.id
		WHERE m.dm_channel_id = ? AND m.is_pinned = 1
		ORDER BY m.created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get pinned DM messages: %w", err)
	}
	defer rows.Close()

	var messages []models.DMMessage
	for rows.Next() {
		msg, err := scanDMMessageRow(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, *msg)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating pinned DM messages: %w", err)
	}

	if messages == nil {
		messages = []models.DMMessage{}
	}
	return messages, nil
}
