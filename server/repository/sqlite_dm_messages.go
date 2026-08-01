package repository

// DM message operations (CRUD and full-text search) for sqliteDMRepo.

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// GetMessages returns DM messages with cursor-based pagination (DESC order).
// Reply references loaded via LEFT JOIN, same pattern as channel messages.
func (r *sqliteDMRepo) GetMessages(ctx context.Context, channelID string, beforeID string, limit int) ([]models.DMMessage, error) {
	var query string
	var args []any

	if beforeID == "" {
		query = `
			SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			       m.reply_to_id, m.is_pinned,
			       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
			       u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.created_at,
			       rm.id, rm.content,
			       ru.id, ru.username, ru.display_name, ru.avatar_url, ru.custom_status, ru.created_at
			FROM dm_messages m
			LEFT JOIN users u ON m.user_id = u.id
			LEFT JOIN dm_messages rm ON m.reply_to_id = rm.id
			LEFT JOIN users ru ON rm.user_id = ru.id
			WHERE m.dm_channel_id = ?
			ORDER BY m.created_at DESC, m.id DESC
			LIMIT ?`
		args = []any{channelID, limit}
	} else {
		// Cursor pagination: fetch messages older than beforeID, using a
		// compound (created_at, id) tiebreak. created_at has only second
		// resolution while id is random hex, so a plain `created_at < X`
		// cursor silently drops rows: whenever more than `limit` messages
		// land in the same second, the ones on the far side of the page
		// boundary never satisfy the strict `<` again and the client sees
		// hasMore:false with messages permanently missing. Expressed as
		// boolean expansion rather than a row-value comparison so it works
		// identically on both the local modernc.org/sqlite driver and the
		// CGO libsql/Turso driver (row-value comparison isn't guaranteed
		// portable across both engines).
		query = `
			SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			       m.reply_to_id, m.is_pinned,
			       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
			       u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.created_at,
			       rm.id, rm.content,
			       ru.id, ru.username, ru.display_name, ru.avatar_url, ru.custom_status, ru.created_at
			FROM dm_messages m
			LEFT JOIN users u ON m.user_id = u.id
			LEFT JOIN dm_messages rm ON m.reply_to_id = rm.id
			LEFT JOIN users ru ON rm.user_id = ru.id
			WHERE m.dm_channel_id = ?
			  AND ( m.created_at < (SELECT created_at FROM dm_messages WHERE id = ?)
			     OR ( m.created_at = (SELECT created_at FROM dm_messages WHERE id = ?)
			          AND m.id < ? ) )
			ORDER BY m.created_at DESC, m.id DESC
			LIMIT ?`
		args = []any{channelID, beforeID, beforeID, beforeID, limit}
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get DM messages: %w", err)
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
		return nil, fmt.Errorf("error iterating DM messages: %w", err)
	}

	if messages == nil {
		messages = []models.DMMessage{}
	}
	return messages, nil
}

func (r *sqliteDMRepo) GetMessageByID(ctx context.Context, id string) (*models.DMMessage, error) {
	query := `
		SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       m.reply_to_id, m.is_pinned,
		       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
		       u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.created_at,
		       rm.id, rm.content,
		       ru.id, ru.username, ru.display_name, ru.avatar_url, ru.custom_status, ru.created_at
		FROM dm_messages m
		LEFT JOIN users u ON m.user_id = u.id
		LEFT JOIN dm_messages rm ON m.reply_to_id = rm.id
		LEFT JOIN users ru ON rm.user_id = ru.id
		WHERE m.id = ?`

	var msg models.DMMessage
	var author models.PublicUser
	// Nullable across every joined author column, not just the id — see
	// scanDMMessageRow.
	var authorID, authorUsername, authorStatus sql.NullString
	var authorCreatedAt sql.NullTime
	var content sql.NullString
	var editedAt sql.NullTime
	var displayName, avatarURL, customStatus sql.NullString
	var isPinned int

	var refMsgID, refMsgContent sql.NullString
	var refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL, refAuthorCustomStatus sql.NullString
	var refAuthorCreatedAt sql.NullTime

	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&msg.ID, &msg.DMChannelID, &msg.UserID, &content, &editedAt, &msg.CreatedAt,
		&msg.ReplyToID, &isPinned,
		&msg.EncryptionVersion, &msg.Ciphertext, &msg.SenderDeviceID, &msg.E2EEMetadata,
		&authorID, &authorUsername, &displayName, &avatarURL, &authorStatus, &customStatus, &authorCreatedAt,
		&refMsgID, &refMsgContent,
		&refAuthorID, &refAuthorUsername, &refAuthorDisplayName, &refAuthorAvatarURL, &refAuthorCustomStatus, &refAuthorCreatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: DM message not found", pkg.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get DM message: %w", err)
	}

	msg.IsPinned = isPinned == 1
	if content.Valid {
		msg.Content = &content.String
	}
	if editedAt.Valid {
		msg.EditedAt = &editedAt.Time
	}
	if authorID.Valid {
		author.ID = authorID.String
		author.Username = authorUsername.String
		author.Status = models.UserStatus(authorStatus.String)
		if displayName.Valid {
			author.DisplayName = &displayName.String
		}
		if avatarURL.Valid {
			author.AvatarURL = &avatarURL.String
		}
		if customStatus.Valid {
			author.CustomStatus = &customStatus.String
		}
		if authorCreatedAt.Valid {
			author.CreatedAt = authorCreatedAt.Time
		}
		msg.Author = &author
	}

	msg.ReferencedMessage = buildMessageReference(
		msg.ReplyToID, refMsgID, refMsgContent,
		refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL, refAuthorCustomStatus, refAuthorCreatedAt,
	)

	return &msg, nil
}

func (r *sqliteDMRepo) CreateMessage(ctx context.Context, msg *models.DMMessage) error {
	// Content can be nil (file-only message)
	var contentPtr *string
	if msg.Content != nil && *msg.Content != "" {
		contentPtr = msg.Content
	}

	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to create DM message: %w", err)
	}
	msg.ID = id

	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO dm_messages (id, dm_channel_id, user_id, content, reply_to_id,
			encryption_version, ciphertext, sender_device_id, e2ee_metadata)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		msg.ID, msg.DMChannelID, msg.UserID, contentPtr, msg.ReplyToID,
		msg.EncryptionVersion, msg.Ciphertext, msg.SenderDeviceID, msg.E2EEMetadata,
	); err != nil {
		return fmt.Errorf("failed to create DM message: %w", err)
	}

	// Best-effort read-back of the DB-side default created_at (RETURNING avoided
	// for Turso/Hrana safety — see sqlite_user.go Create).
	_ = r.db.QueryRowContext(ctx, "SELECT created_at FROM dm_messages WHERE id = ?", msg.ID).Scan(&msg.CreatedAt)
	msg.CreatedAt = msg.CreatedAt.UTC()
	return nil
}

// UpdateMessage edits a DM message.
// E2EE messages update ciphertext; plaintext messages update content.
func (r *sqliteDMRepo) UpdateMessage(ctx context.Context, id string, req *models.UpdateDMMessageRequest) error {
	now := time.Now().UTC()

	var result sql.Result
	var err error

	if req.EncryptionVersion == 1 {
		result, err = r.db.ExecContext(ctx,
			`UPDATE dm_messages SET ciphertext = ?, sender_device_id = ?, e2ee_metadata = ?, edited_at = ? WHERE id = ?`,
			req.Ciphertext, req.SenderDeviceID, req.E2EEMetadata, now, id,
		)
	} else {
		result, err = r.db.ExecContext(ctx,
			"UPDATE dm_messages SET content = ?, edited_at = ? WHERE id = ?",
			req.Content, now, id,
		)
	}

	if err != nil {
		return fmt.Errorf("failed to update DM message: %w", err)
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

func (r *sqliteDMRepo) DeleteMessage(ctx context.Context, id string) error {
	result, err := r.db.ExecContext(ctx, "DELETE FROM dm_messages WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("failed to delete DM message: %w", err)
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

// SearchMessages performs FTS5 full-text search on DM messages.
// Returns paginated results ranked by BM25, plus total count for pagination.
func (r *sqliteDMRepo) SearchMessages(ctx context.Context, channelID string, searchQuery string, limit, offset int) ([]models.DMMessage, int, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	safeQuery := sanitizeFTSQuery(searchQuery)
	if safeQuery == "" {
		return []models.DMMessage{}, 0, nil
	}

	// Total count
	countQuery := `
		SELECT COUNT(*)
		FROM dm_messages_fts fts
		JOIN dm_messages m ON m.rowid = fts.rowid
		WHERE dm_messages_fts MATCH ? AND m.dm_channel_id = ?`

	var totalCount int
	if err := r.db.QueryRowContext(ctx, countQuery, safeQuery, channelID).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("failed to count DM search results: %w", err)
	}

	if totalCount == 0 {
		return []models.DMMessage{}, 0, nil
	}

	// Paginated results ranked by BM25
	dataQuery := `
		SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       m.reply_to_id, m.is_pinned,
		       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
		       u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.created_at,
		       rm.id, rm.content,
		       ru.id, ru.username, ru.display_name, ru.avatar_url, ru.custom_status, ru.created_at
		FROM dm_messages m
		JOIN dm_messages_fts fts ON fts.rowid = m.rowid
		LEFT JOIN users u ON m.user_id = u.id
		LEFT JOIN dm_messages rm ON m.reply_to_id = rm.id
		LEFT JOIN users ru ON rm.user_id = ru.id
		WHERE m.dm_channel_id = ? AND fts.content MATCH ?
		ORDER BY fts.rank
		LIMIT ? OFFSET ?`

	rows, err := r.db.QueryContext(ctx, dataQuery, channelID, safeQuery, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to search DM messages: %w", err)
	}
	defer rows.Close()

	var messages []models.DMMessage
	for rows.Next() {
		msg, err := scanDMMessageRow(rows)
		if err != nil {
			return nil, 0, err
		}
		messages = append(messages, *msg)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating DM search results: %w", err)
	}

	if messages == nil {
		messages = []models.DMMessage{}
	}
	return messages, totalCount, nil
}
