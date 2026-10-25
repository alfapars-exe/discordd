package repository

import (
	"context"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/models"
)

func postgresSearchTerms(query string) ([]string, []any) {
	conditions := []string{"m.encryption_version = 0"}
	var args []any
	for _, word := range strings.Fields(query) {
		word = strings.NewReplacer(`"`, "", "*", "").Replace(word)
		if len([]rune(word)) < 3 {
			continue
		}
		word = strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(word)
		conditions = append(conditions, `m.content ILIKE ? ESCAPE '\'`)
		args = append(args, "%"+word+"%")
	}
	return conditions, args
}
func searchPage(limit, offset int) (int, int) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}

func (r *sqliteSearchRepo) searchPostgres(ctx context.Context, query, serverID string, channelID *string, allowed []string, limit, offset int) (*SearchResult, error) {
	result := &SearchResult{Messages: []models.Message{}}
	conditions, args := postgresSearchTerms(query)
	if len(args) == 0 || (allowed != nil && len(allowed) == 0) {
		return result, nil
	}
	conditions = append(conditions, "ch.server_id = ?")
	args = append(args, serverID)
	if channelID != nil {
		conditions = append(conditions, "m.channel_id = ?")
		args = append(args, *channelID)
	}
	if allowed != nil {
		conditions = append(conditions, "m.channel_id IN ("+strings.TrimSuffix(strings.Repeat("?,", len(allowed)), ",")+")")
		for _, id := range allowed {
			args = append(args, id)
		}
	}
	from := ` FROM messages m JOIN channels ch ON ch.id=m.channel_id `
	where := " WHERE " + strings.Join(conditions, " AND ")
	if err := r.db.QueryRowContext(ctx, "SELECT COUNT(*)"+from+where, args...).Scan(&result.TotalCount); err != nil {
		return nil, fmt.Errorf("count search results: %w", err)
	}
	if result.TotalCount == 0 {
		return result, nil
	}
	limit, offset = searchPage(limit, offset)
	rows, err := r.db.QueryContext(ctx, `SELECT m.id,m.channel_id,m.user_id,m.content,m.edited_at,m.created_at,
	 u.id,u.username,u.display_name,u.avatar_url,u.status,u.custom_status,u.created_at`+from+
		` LEFT JOIN users u ON m.user_id=u.id `+where+` ORDER BY m.created_at DESC,m.id DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return nil, err
	}
	result.Messages, err = scanRows(rows, "search result", scanSearchResult)
	if result.Messages == nil {
		result.Messages = []models.Message{}
	}
	return result, err
}

func (r *sqliteDMRepo) searchPostgres(ctx context.Context, channelID, query string, limit, offset int) ([]models.DMMessage, int, error) {
	messages := []models.DMMessage{}
	conditions, args := postgresSearchTerms(query)
	if len(args) == 0 {
		return messages, 0, nil
	}
	conditions = append(conditions, "m.dm_channel_id = ?")
	args = append(args, channelID)
	where := " WHERE " + strings.Join(conditions, " AND ")
	var count int
	if err := r.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM dm_messages m"+where, args...).Scan(&count); err != nil {
		return nil, 0, err
	}
	if count == 0 {
		return messages, 0, nil
	}
	limit, offset = searchPage(limit, offset)
	rows, err := r.db.QueryContext(ctx, `SELECT m.id,m.dm_channel_id,m.user_id,m.content,m.edited_at,m.created_at,
	 m.reply_to_id,m.is_pinned,m.encryption_version,m.ciphertext,m.sender_device_id,m.e2ee_metadata,
	 u.id,u.username,u.display_name,u.avatar_url,u.status,u.custom_status,u.created_at,
	 rm.id,rm.content,ru.id,ru.username,ru.display_name,ru.avatar_url,ru.status,ru.custom_status,ru.created_at
	 FROM dm_messages m LEFT JOIN users u ON m.user_id=u.id
	 LEFT JOIN dm_messages rm ON m.reply_to_id=rm.id LEFT JOIN users ru ON rm.user_id=ru.id`+
		where+` ORDER BY m.created_at DESC,m.id DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		message, err := scanDMMessageRow(rows)
		if err != nil {
			return nil, 0, err
		}
		messages = append(messages, *message)
	}
	return messages, count, rows.Err()
}
