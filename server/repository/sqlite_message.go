package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteMessageRepo struct {
	db database.TxQuerier
}

func NewSQLiteMessageRepo(db database.TxQuerier) MessageRepository {
	return &sqliteMessageRepo{db: db}
}

func (r *sqliteMessageRepo) Create(ctx context.Context, message *models.Message) error {
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to create message: %w", err)
	}
	message.ID = id

	query := `
		INSERT INTO messages (id, channel_id, user_id, content, reply_to_id,
			encryption_version, ciphertext, sender_device_id, e2ee_metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

	if _, err := r.db.ExecContext(ctx, query,
		message.ID,
		message.ChannelID,
		message.UserID,
		message.Content,
		message.ReplyToID,
		message.EncryptionVersion,
		message.Ciphertext,
		message.SenderDeviceID,
		message.E2EEMetadata,
	); err != nil {
		return fmt.Errorf("failed to create message: %w", err)
	}

	// Best-effort read-back of the DB-side default created_at (RETURNING avoided
	// for Turso/Hrana safety — see sqlite_user.go Create). created_at feeds the
	// WS broadcast; on the rare read-back miss it stays zero rather than 500ing
	// the send — the row itself is persisted with the correct timestamp.
	_ = r.db.QueryRowContext(ctx, "SELECT created_at FROM messages WHERE id = ?", message.ID).Scan(&message.CreatedAt)

	return nil
}

func (r *sqliteMessageRepo) GetByID(ctx context.Context, id string) (*models.Message, error) {
	// LEFT JOIN: message stays visible even if author is deleted.
	// Reply reference (rm/ru) loaded via LEFT JOIN.
	query := `
		SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at, m.reply_to_id,
		       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
		       u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.created_at,
		       rm.id, rm.content,
		       ru.id, ru.username, ru.display_name, ru.avatar_url, ru.status, ru.custom_status, ru.created_at
		FROM messages m
		LEFT JOIN users u ON m.user_id = u.id
		LEFT JOIN messages rm ON m.reply_to_id = rm.id
		LEFT JOIN users ru ON rm.user_id = ru.id
		WHERE m.id = ?`

	msg := &models.Message{}
	var author models.PublicUser
	// Every joined author column must be nullable, not just the id: a dangling
	// user_id makes the LEFT JOIN yield NULL for ALL of them, and a NULL landing
	// in a plain string fails the whole row scan. See scanMessage.
	var authorID, authorUsername, authorStatus sql.NullString
	var authorCreatedAt sql.NullTime

	var refMsgID, refMsgContent sql.NullString
	var refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL, refAuthorStatus, refAuthorCustomStatus sql.NullString
	var refAuthorCreatedAt sql.NullTime

	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Content, &msg.EditedAt, &msg.CreatedAt, &msg.ReplyToID,
		&msg.EncryptionVersion, &msg.Ciphertext, &msg.SenderDeviceID, &msg.E2EEMetadata,
		&authorID, &authorUsername, &author.DisplayName, &author.AvatarURL, &authorStatus, &author.CustomStatus, &authorCreatedAt,
		&refMsgID, &refMsgContent,
		&refAuthorID, &refAuthorUsername, &refAuthorDisplayName, &refAuthorAvatarURL, &refAuthorStatus, &refAuthorCustomStatus, &refAuthorCreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get message by id: %w", err)
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

	msg.ReferencedMessage = buildMessageReference(msg.ReplyToID, refMsgID, refMsgContent, refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL, refAuthorStatus, refAuthorCustomStatus, refAuthorCreatedAt)

	return msg, nil
}

// scanMessage scans one channel-history row into a Message, attaching the
// author (nullable via LEFT JOIN) and the reply reference (rm/ru, also via
// LEFT JOIN) built by buildMessageReference.
//
// The author columns are scanned through NullStrings because the LEFT JOIN
// really can come back empty: messages.user_id has ON DELETE CASCADE, but FKs
// are enforced only on the local SQLite branch of database.New — the remote
// libSQL/Turso branch production runs on sets no pragmas at all, and the repo
// already ships an orphan census because dangling rows are a known production
// condition. Scanning a NULL into a plain string fails the row, and since
// GetByChannelID funnels every row through here, one authorless message would
// otherwise take down the entire page rather than just itself.
func scanMessage(rows *sql.Rows) (models.Message, error) {
	var msg models.Message
	var author models.PublicUser
	var authorID, authorUsername, authorStatus sql.NullString
	var authorCreatedAt sql.NullTime

	var refMsgID, refMsgContent sql.NullString
	var refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL, refAuthorStatus, refAuthorCustomStatus sql.NullString
	var refAuthorCreatedAt sql.NullTime

	if err := rows.Scan(
		&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Content, &msg.EditedAt, &msg.CreatedAt, &msg.ReplyToID,
		&msg.EncryptionVersion, &msg.Ciphertext, &msg.SenderDeviceID, &msg.E2EEMetadata,
		&authorID, &authorUsername, &author.DisplayName, &author.AvatarURL, &authorStatus, &author.CustomStatus, &authorCreatedAt,
		&refMsgID, &refMsgContent,
		&refAuthorID, &refAuthorUsername, &refAuthorDisplayName, &refAuthorAvatarURL, &refAuthorStatus, &refAuthorCustomStatus, &refAuthorCreatedAt,
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

	msg.ReferencedMessage = buildMessageReference(msg.ReplyToID, refMsgID, refMsgContent, refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL, refAuthorStatus, refAuthorCustomStatus, refAuthorCreatedAt)

	return msg, nil
}

// GetByChannelID returns messages with cursor-based pagination.
// Reply references are loaded via LEFT JOIN (max 1 per message, so JOIN is preferred over batch).
// Results are DESC-ordered (frontend reverses for display).
func (r *sqliteMessageRepo) GetByChannelID(ctx context.Context, channelID string, beforeID string, limit int) ([]models.Message, error) {
	var query string
	var args []any

	if beforeID == "" {
		query = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at, m.reply_to_id,
			       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
			       u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.created_at,
			       rm.id, rm.content,
			       ru.id, ru.username, ru.display_name, ru.avatar_url, ru.status, ru.custom_status, ru.created_at
			FROM messages m
			LEFT JOIN users u ON m.user_id = u.id
			LEFT JOIN messages rm ON m.reply_to_id = rm.id
			LEFT JOIN users ru ON rm.user_id = ru.id
			WHERE m.channel_id = ?
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
			SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at, m.reply_to_id,
			       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
			       u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.created_at,
			       rm.id, rm.content,
			       ru.id, ru.username, ru.display_name, ru.avatar_url, ru.status, ru.custom_status, ru.created_at
			FROM messages m
			LEFT JOIN users u ON m.user_id = u.id
			LEFT JOIN messages rm ON m.reply_to_id = rm.id
			LEFT JOIN users ru ON rm.user_id = ru.id
			WHERE m.channel_id = ?
			  AND ( m.created_at < (SELECT created_at FROM messages WHERE id = ?)
			     OR ( m.created_at = (SELECT created_at FROM messages WHERE id = ?)
			          AND m.id < ? ) )
			ORDER BY m.created_at DESC, m.id DESC
			LIMIT ?`
		args = []any{channelID, beforeID, beforeID, beforeID, limit}
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get messages by channel: %w", err)
	}

	messages, err := scanRows(rows, "message", scanMessage)
	if err != nil {
		return nil, err
	}

	return messages, nil
}

// Update edits a message. For E2EE channel messages (encryption_version=1)
// the new ciphertext + sender_device_id + e2ee_metadata are persisted so the
// edited body actually survives a reload — previously this branch only
// touched `content` and `edited_at`, which meant the post-edit ciphertext
// got broadcast over WS but never written to the DB. Anyone fetching message
// history (page refresh, scrollback, search) saw the pre-edit ciphertext or
// an unparseable mix, depending on what the row still held in `content`.
//
// Mirrors sqliteDMRepo.UpdateMessage's E2EE branching so behaviour is
// uniform across channel and DM edits.
func (r *sqliteMessageRepo) Update(ctx context.Context, message *models.Message) error {
	now := time.Now()

	var result sql.Result
	var err error

	if message.EncryptionVersion == 1 {
		query := `UPDATE messages SET ciphertext = ?, sender_device_id = ?, e2ee_metadata = ?, edited_at = ? WHERE id = ?`
		result, err = r.db.ExecContext(ctx, query,
			message.Ciphertext, message.SenderDeviceID, message.E2EEMetadata, now, message.ID,
		)
	} else {
		query := `UPDATE messages SET content = ?, edited_at = ? WHERE id = ?`
		result, err = r.db.ExecContext(ctx, query, message.Content, now, message.ID)
	}
	if err != nil {
		return fmt.Errorf("failed to update message: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	message.EditedAt = &now
	return nil
}

func (r *sqliteMessageRepo) Delete(ctx context.Context, id string) error {
	// Attachments CASCADE-deleted. Reply references preserved (no FK):
	// reply_to_id stays, LEFT JOIN returns NULL -> frontend shows "deleted message".
	result, err := r.db.ExecContext(ctx, `DELETE FROM messages WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete message: %w", err)
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

// buildMessageReference builds a MessageReference from LEFT JOIN results.
//
// Three cases:
// 1. replyToID nil -> not a reply -> nil
// 2. replyToID set, refMsgID NULL -> referenced message deleted -> empty ref with ID only
// 3. replyToID set, refMsgID set -> full reference with author + content
func buildMessageReference(
	replyToID *string,
	refMsgID, refMsgContent sql.NullString,
	refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL, refAuthorStatus, refAuthorCustomStatus sql.NullString,
	refAuthorCreatedAt sql.NullTime,
) *models.MessageReference {
	if replyToID == nil {
		return nil
	}

	ref := &models.MessageReference{
		ID: *replyToID,
	}

	if refMsgID.Valid {
		if refMsgContent.Valid {
			ref.Content = &refMsgContent.String
		}

		if refAuthorID.Valid {
			refAuthor := &models.PublicUser{
				ID:       refAuthorID.String,
				Username: refAuthorUsername.String,
			}
			if refAuthorStatus.Valid {
				refAuthor.Status = models.UserStatus(refAuthorStatus.String)
			}
			if refAuthorDisplayName.Valid {
				refAuthor.DisplayName = &refAuthorDisplayName.String
			}
			if refAuthorCustomStatus.Valid {
				refAuthor.CustomStatus = &refAuthorCustomStatus.String
			}
			if refAuthorCreatedAt.Valid {
				refAuthor.CreatedAt = refAuthorCreatedAt.Time
			}
			if refAuthorAvatarURL.Valid {
				refAuthor.AvatarURL = &refAuthorAvatarURL.String
			}
			ref.Author = refAuthor
		}
	}
	// refMsgID invalid -> referenced message deleted, Author and Content stay nil

	return ref
}
