package repository

// DM reaction operations for sqliteDMRepo.

import (
	"context"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/models"
)

// ToggleReaction adds or removes a DM reaction.
// INSERT OR IGNORE -> if rowsAffected == 0 (UNIQUE hit) -> DELETE. Atomic toggle.
func (r *sqliteDMRepo) ToggleReaction(ctx context.Context, messageID, userID, emoji string) (bool, error) {
	insertQuery := `
		INSERT OR IGNORE INTO dm_reactions (id, dm_message_id, user_id, emoji)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?)`

	result, err := r.db.ExecContext(ctx, insertQuery, messageID, userID, emoji)
	if err != nil {
		return false, fmt.Errorf("toggle DM reaction insert: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("toggle DM reaction rows affected: %w", err)
	}

	if rowsAffected > 0 {
		return true, nil // added
	}

	// Already exists -> remove
	deleteQuery := `DELETE FROM dm_reactions WHERE dm_message_id = ? AND user_id = ? AND emoji = ?`
	_, err = r.db.ExecContext(ctx, deleteQuery, messageID, userID, emoji)
	if err != nil {
		return false, fmt.Errorf("toggle DM reaction delete: %w", err)
	}

	return false, nil
}

func (r *sqliteDMRepo) GetReactionsByMessageID(ctx context.Context, messageID string) ([]models.ReactionGroup, error) {
	query := `
		SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users
		FROM dm_reactions
		WHERE dm_message_id = ?
		GROUP BY emoji
		ORDER BY MIN(created_at) ASC`

	rows, err := r.db.QueryContext(ctx, query, messageID)
	if err != nil {
		return nil, fmt.Errorf("get DM reactions by message: %w", err)
	}
	defer rows.Close()

	return scanReactionGroups(rows)
}

// GetReactionsByMessageIDs batch-loads reactions for multiple DM messages (avoids N+1).
func (r *sqliteDMRepo) GetReactionsByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error) {
	if len(messageIDs) == 0 {
		return make(map[string][]models.ReactionGroup), nil
	}

	placeholders := make([]string, len(messageIDs))
	args := make([]any, len(messageIDs))
	for i, id := range messageIDs {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf(`
		SELECT dm_message_id, emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users
		FROM dm_reactions
		WHERE dm_message_id IN (%s)
		GROUP BY dm_message_id, emoji
		ORDER BY dm_message_id, MIN(created_at) ASC`,
		strings.Join(placeholders, ","))

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get DM reactions by message ids: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]models.ReactionGroup)
	for rows.Next() {
		var messageID, emoji, usersStr string
		var count int
		if err := rows.Scan(&messageID, &emoji, &count, &usersStr); err != nil {
			return nil, fmt.Errorf("scan DM reaction group: %w", err)
		}

		users := strings.Split(usersStr, ",")
		result[messageID] = append(result[messageID], models.ReactionGroup{
			Emoji: emoji,
			Count: count,
			Users: users,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate DM reaction rows: %w", err)
	}

	return result, nil
}
