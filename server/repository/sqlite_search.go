package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type sqliteSearchRepo struct {
	db database.TxQuerier
}

func NewSQLiteSearchRepo(db database.TxQuerier) SearchRepository {
	return &sqliteSearchRepo{db: db}
}

// scanSearchResult scans one FTS search result row into a Message, attaching
// the author (nullable via LEFT JOIN) and an empty attachments slice.
func scanSearchResult(rows *sql.Rows) (models.Message, error) {
	var msg models.Message
	var author models.PublicUser
	// Every joined author column must be nullable, not just the id: a dangling
	// user_id makes the LEFT JOIN yield NULL for ALL of them, and a NULL landing
	// in a plain string fails the row scan — which here would drop the whole
	// page of search results, not just the one message. Same defect and same
	// fix as sqlite_message.go's scanMessage.
	var authorID, authorUsername, authorStatus sql.NullString
	var authorCreatedAt sql.NullTime

	if err := rows.Scan(
		&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
		&authorID, &authorUsername, &author.DisplayName, &author.AvatarURL, &authorStatus, &author.CustomStatus, &authorCreatedAt,
	); err != nil {
		return msg, err
	}

	if authorID.Valid {
		author.ID = authorID.String
		author.Username = authorUsername.String
		author.Status = models.UserStatus(authorStatus.String)
		if authorCreatedAt.Valid {
			author.CreatedAt = authorCreatedAt.Time
		}
		msg.Author = &author
	}
	msg.Attachments = []models.Attachment{}

	return msg, nil
}

// Search performs FTS5 full-text search with BM25 ranking.
//
// allowedChannelIDs (H-05) is an RBAC scoping filter built by SearchService
// from the caller's channel-read permission: nil applies no extra filter
// (admin), a non-nil slice restricts to exactly those channel IDs. It is
// folded into the same WHERE clause used by both the count and the data
// query below (via buildSearchFilter) so the two can never disagree about
// which rows are in scope — a page filtered correctly but a total count
// that wasn't would itself leak how many messages exist in a channel the
// caller cannot read.
func (r *sqliteSearchRepo) Search(ctx context.Context, query string, serverID string, channelID *string, allowedChannelIDs []string, limit, offset int) (*SearchResult, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	safeQuery := sanitizeFTSQuery(query)
	if safeQuery == "" {
		return &SearchResult{Messages: []models.Message{}, TotalCount: 0}, nil
	}
	// A non-nil-but-empty allow-list means the caller may read zero
	// channels — defensive mirror of SearchService's own empty-list short
	// circuit, in case a future caller reaches the repository directly.
	if allowedChannelIDs != nil && len(allowedChannelIDs) == 0 {
		return &SearchResult{Messages: []models.Message{}, TotalCount: 0}, nil
	}

	where, args := buildSearchFilter(safeQuery, serverID, channelID, allowedChannelIDs)

	countQuery := `
		SELECT COUNT(*)
		FROM messages_fts fts
		JOIN messages m ON m.rowid = fts.rowid
		JOIN channels ch ON ch.id = m.channel_id
		WHERE ` + where

	var totalCount int
	if err := r.db.QueryRowContext(ctx, countQuery, args...).Scan(&totalCount); err != nil {
		return nil, fmt.Errorf("failed to count search results: %w", err)
	}

	if totalCount == 0 {
		return &SearchResult{Messages: []models.Message{}, TotalCount: 0}, nil
	}

	dataQuery := `
		SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.created_at
		FROM messages_fts fts
		JOIN messages m ON m.rowid = fts.rowid
		JOIN channels ch ON ch.id = m.channel_id
		LEFT JOIN users u ON m.user_id = u.id
		WHERE ` + where + `
		ORDER BY fts.rank
		LIMIT ? OFFSET ?`
	dataArgs := append(append([]any{}, args...), limit, offset)

	rows, err := r.db.QueryContext(ctx, dataQuery, dataArgs...)
	if err != nil {
		return nil, fmt.Errorf("failed to search messages: %w", err)
	}

	messages, err := scanRows(rows, "search result", scanSearchResult)
	if err != nil {
		return nil, err
	}

	if messages == nil {
		messages = []models.Message{}
	}

	return &SearchResult{
		Messages:   messages,
		TotalCount: totalCount,
	}, nil
}

// buildSearchFilter builds the WHERE clause (and matching bind args, in
// order) shared by Search's count and data queries. Kept as a single
// function so the two queries can never drift apart on which rows are in
// scope.
func buildSearchFilter(safeQuery, serverID string, channelID *string, allowedChannelIDs []string) (string, []any) {
	conditions := []string{"messages_fts MATCH ?", "ch.server_id = ?"}
	args := []any{safeQuery, serverID}

	if channelID != nil {
		conditions = append(conditions, "m.channel_id = ?")
		args = append(args, *channelID)
	}

	if allowedChannelIDs != nil {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(allowedChannelIDs)), ",")
		conditions = append(conditions, fmt.Sprintf("m.channel_id IN (%s)", placeholders))
		for _, id := range allowedChannelIDs {
			args = append(args, id)
		}
	}

	return strings.Join(conditions, " AND "), args
}

// sanitizeFTSQuery wraps each word in quotes for FTS5 MATCH. With the trigram
// tokenizer (migration 057) each quoted phrase is matched as a substring — no
// prefix wildcard needed. Quoting neutralises FTS5 operators in user input.
// Trigram requires at least 3 characters to match; shorter tokens are dropped.
func sanitizeFTSQuery(query string) string {
	words := strings.Fields(query)
	if len(words) == 0 {
		return ""
	}

	var safe []string
	for _, w := range words {
		cleaned := strings.ReplaceAll(w, "\"", "")
		cleaned = strings.ReplaceAll(cleaned, "*", "")
		if len([]rune(cleaned)) < 3 {
			continue
		}
		safe = append(safe, "\""+cleaned+"\"")
	}

	if len(safe) == 0 {
		return ""
	}

	return strings.Join(safe, " ")
}
