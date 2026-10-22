package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteSavedRepo struct {
	db database.TxQuerier
}

func NewSQLiteSavedRepo(db database.TxQuerier) SavedRepository {
	return &sqliteSavedRepo{db: db}
}

func (r *sqliteSavedRepo) Create(ctx context.Context, s *models.SavedMessage) error {
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to create saved message: %w", err)
	}
	s.ID = id

	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO saved_messages (id, user_id, message_id, dm_message_id, note) VALUES (?, ?, ?, ?, ?)`,
		s.ID, s.UserID, s.MessageID, s.DMMessageID, s.Note,
	); err != nil {
		return fmt.Errorf("failed to create saved message: %w", err)
	}

	// Best-effort read-back of the DB-side default created_at (RETURNING
	// avoided for Turso/Hrana safety — see sqlite_user.go Create).
	var createdAt string
	if err := r.db.QueryRowContext(ctx, "SELECT created_at FROM saved_messages WHERE id = ?", s.ID).Scan(&createdAt); err == nil {
		s.CreatedAt = dbTextToRFC3339(createdAt)
	}
	return nil
}

// savedSelect is the shared hydrating SELECT. Every joined column is
// nullable on the Go side: a saved row references a channel message XOR a
// DM message, so one whole side of the join is NULL by construction, and the
// other side can also be NULL when the referenced row was deleted without
// the (Turso-unenforced) cascade firing. attachment_count is a correlated
// COUNT — 0, never NULL, when the message side is absent.
const savedSelect = `
	SELECT s.id, s.user_id, s.note, s.created_at, s.message_id, s.dm_message_id,
	       m.id, m.channel_id, c.server_id, c.name, sv.name, m.user_id, m.content, m.created_at,
	       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
	       (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id),
	       mu.id, mu.username, mu.display_name, mu.avatar_url, mu.status, mu.custom_status, mu.created_at,
	       d.id, d.dm_channel_id, d.user_id, d.content, d.created_at,
	       d.encryption_version, d.ciphertext, d.sender_device_id, d.e2ee_metadata,
	       (SELECT COUNT(*) FROM dm_attachments da WHERE da.dm_message_id = d.id),
	       du.id, du.username, du.display_name, du.avatar_url, du.status, du.custom_status, du.created_at
	FROM saved_messages s
	LEFT JOIN messages m ON m.id = s.message_id
	LEFT JOIN channels c ON c.id = m.channel_id
	LEFT JOIN servers sv ON sv.id = c.server_id
	LEFT JOIN users mu ON mu.id = m.user_id
	LEFT JOIN dm_messages d ON d.id = s.dm_message_id
	LEFT JOIN users du ON du.id = d.user_id
	WHERE s.user_id = ?`

// query runs savedSelect with an extra WHERE fragment (already prefixed with
// AND, may be empty) and the ORDER/LIMIT tail. Every matching row is
// returned — one whose reference is gone comes back as the unavailable stub
// (see scanSavedRow), so the row count always equals the raw row count and
// keyset pagination stays exact.
func (r *sqliteSavedRepo) query(ctx context.Context, where string, args []any, limit int) ([]models.SavedMessage, error) {
	q := savedSelect + where + ` ORDER BY s.created_at DESC, s.id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list saved messages: %w", err)
	}
	defer rows.Close()

	list := []models.SavedMessage{}
	for rows.Next() {
		s, err := scanSavedRow(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, *s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating saved messages: %w", err)
	}
	return list, nil
}

// scanSavedRow scans one savedSelect row. When neither the channel-message
// nor the DM-message side joined (a dangling bookmark) the row comes back as
// the unavailable stub: its own columns only, Message/DMMessage nil.
func scanSavedRow(rows *sql.Rows) (*models.SavedMessage, error) {
	var out models.SavedMessage
	var note, messageID, dmMessageID sql.NullString
	var createdAt string

	var mID, mChannelID, mServerID, mChannelName, mServerName, mUserID, mContent sql.NullString
	var mCreatedAt sql.NullTime
	var mEncryptionVersion sql.NullInt64
	var mCiphertext, mSenderDeviceID, mE2EEMetadata sql.NullString
	var mAttachmentCount int
	var muID, muUsername, muDisplayName, muAvatarURL, muStatus, muCustomStatus sql.NullString
	var muCreatedAt sql.NullTime

	var dID, dChannelID, dUserID, dContent sql.NullString
	var dCreatedAt sql.NullTime
	var dEncryptionVersion sql.NullInt64
	var dCiphertext, dSenderDeviceID, dE2EEMetadata sql.NullString
	var dAttachmentCount int
	var duID, duUsername, duDisplayName, duAvatarURL, duStatus, duCustomStatus sql.NullString
	var duCreatedAt sql.NullTime

	if err := rows.Scan(
		&out.ID, &out.UserID, &note, &createdAt, &messageID, &dmMessageID,
		&mID, &mChannelID, &mServerID, &mChannelName, &mServerName, &mUserID, &mContent, &mCreatedAt,
		&mEncryptionVersion, &mCiphertext, &mSenderDeviceID, &mE2EEMetadata,
		&mAttachmentCount,
		&muID, &muUsername, &muDisplayName, &muAvatarURL, &muStatus, &muCustomStatus, &muCreatedAt,
		&dID, &dChannelID, &dUserID, &dContent, &dCreatedAt,
		&dEncryptionVersion, &dCiphertext, &dSenderDeviceID, &dE2EEMetadata,
		&dAttachmentCount,
		&duID, &duUsername, &duDisplayName, &duAvatarURL, &duStatus, &duCustomStatus, &duCreatedAt,
	); err != nil {
		return nil, fmt.Errorf("failed to scan saved message: %w", err)
	}

	out.Note = nullStringPtr(note)
	out.CreatedAt = dbTextToRFC3339(createdAt)
	out.MessageID = nullStringPtr(messageID)
	out.DMMessageID = nullStringPtr(dmMessageID)

	if !mID.Valid && !dID.Valid {
		out.AsUnavailable()
		return &out, nil
	}

	if mID.Valid {
		msg := &models.SavedChannelMessage{
			ID:                mID.String,
			ChannelID:         mChannelID.String,
			ServerID:          mServerID.String,
			ChannelName:       mChannelName.String,
			ServerName:        mServerName.String,
			UserID:            mUserID.String,
			Content:           nullStringPtr(mContent),
			EncryptionVersion: int(mEncryptionVersion.Int64),
			Ciphertext:        nullStringPtr(mCiphertext),
			SenderDeviceID:    nullStringPtr(mSenderDeviceID),
			E2EEMetadata:      nullStringPtr(mE2EEMetadata),
			AttachmentCount:   mAttachmentCount,
			Author:            savedAuthor(muID, muUsername, muDisplayName, muAvatarURL, muStatus, muCustomStatus, muCreatedAt),
		}
		if mCreatedAt.Valid {
			msg.CreatedAt = mCreatedAt.Time
		}
		out.Message = msg
	}
	if dID.Valid {
		msg := &models.SavedDMMessage{
			ID:                dID.String,
			DMChannelID:       dChannelID.String,
			UserID:            dUserID.String,
			Content:           nullStringPtr(dContent),
			EncryptionVersion: int(dEncryptionVersion.Int64),
			Ciphertext:        nullStringPtr(dCiphertext),
			SenderDeviceID:    nullStringPtr(dSenderDeviceID),
			E2EEMetadata:      nullStringPtr(dE2EEMetadata),
			AttachmentCount:   dAttachmentCount,
			Author:            savedAuthor(duID, duUsername, duDisplayName, duAvatarURL, duStatus, duCustomStatus, duCreatedAt),
		}
		if dCreatedAt.Valid {
			msg.CreatedAt = dCreatedAt.Time
		}
		out.DMMessage = msg
	}
	return &out, nil
}

// savedAuthor builds the LEFT JOINed author view; nil when the users row is
// gone (same rule as scanMessage / scanNotificationRow).
func savedAuthor(id, username, displayName, avatarURL, status, customStatus sql.NullString, createdAt sql.NullTime) *models.PublicUser {
	if !id.Valid {
		return nil
	}
	author := &models.PublicUser{
		ID:           id.String,
		Username:     username.String,
		Status:       models.UserStatus(status.String),
		DisplayName:  nullStringPtr(displayName),
		AvatarURL:    nullStringPtr(avatarURL),
		CustomStatus: nullStringPtr(customStatus),
	}
	if createdAt.Valid {
		author.CreatedAt = createdAt.Time
	}
	return author
}

func (r *sqliteSavedRepo) GetByID(ctx context.Context, userID, id string) (*models.SavedMessage, error) {
	list, err := r.query(ctx, ` AND s.id = ?`, []any{userID, id}, 1)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, fmt.Errorf("%w: saved message not found", pkg.ErrNotFound)
	}
	return &list[0], nil
}

func (r *sqliteSavedRepo) FindByRef(ctx context.Context, userID, messageID, dmMessageID string) (*models.SavedMessage, error) {
	var list []models.SavedMessage
	var err error
	switch {
	case messageID != "":
		list, err = r.query(ctx, ` AND s.message_id = ?`, []any{userID, messageID}, 1)
	case dmMessageID != "":
		list, err = r.query(ctx, ` AND s.dm_message_id = ?`, []any{userID, dmMessageID}, 1)
	default:
		return nil, errors.New("FindByRef requires a message_id or dm_message_id")
	}
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, nil
	}
	return &list[0], nil
}

// List — keyset pagination in the boolean-expanded form SQLite accepts
// (`a < X OR (a = X AND b < Y)`, no row-value comparison). The cursor
// subquery is scoped to the caller's own rows, so a foreign or unknown
// beforeID makes it NULL, every comparison is NULL and the page is empty.
// The cursor compares the raw stored column, so the RFC3339 conversion
// applied to the emitted rows does not affect it.
func (r *sqliteSavedRepo) List(ctx context.Context, userID, beforeID string, limit int) ([]models.SavedMessage, error) {
	where := ""
	args := []any{userID}
	if beforeID != "" {
		where = ` AND (s.created_at < (SELECT created_at FROM saved_messages WHERE id = ? AND user_id = ?)
		          OR (s.created_at = (SELECT created_at FROM saved_messages WHERE id = ? AND user_id = ?) AND s.id < ?))`
		args = append(args, beforeID, userID, beforeID, userID, beforeID)
	}
	return r.query(ctx, where, args, limit)
}

func (r *sqliteSavedRepo) ListIDs(ctx context.Context, userID string) ([]string, []string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT message_id, dm_message_id FROM saved_messages WHERE user_id = ?`, userID)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to list saved message ids: %w", err)
	}
	defer rows.Close()

	messageIDs, dmMessageIDs := []string{}, []string{}
	for rows.Next() {
		var messageID, dmMessageID sql.NullString
		if err := rows.Scan(&messageID, &dmMessageID); err != nil {
			return nil, nil, fmt.Errorf("failed to scan saved message id: %w", err)
		}
		if messageID.Valid {
			messageIDs = append(messageIDs, messageID.String)
		}
		if dmMessageID.Valid {
			dmMessageIDs = append(dmMessageIDs, dmMessageID.String)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("error iterating saved message ids: %w", err)
	}
	return messageIDs, dmMessageIDs, nil
}

func (r *sqliteSavedRepo) Count(ctx context.Context, userID string) (int, error) {
	var n int
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM saved_messages WHERE user_id = ?`, userID,
	).Scan(&n); err != nil {
		return 0, fmt.Errorf("failed to count saved messages: %w", err)
	}
	return n, nil
}

func (r *sqliteSavedRepo) UpdateNote(ctx context.Context, userID, id string, note *string) (bool, error) {
	result, err := r.db.ExecContext(ctx,
		`UPDATE saved_messages SET note = ? WHERE id = ? AND user_id = ?`, note, id, userID)
	if err != nil {
		return false, fmt.Errorf("failed to update saved message note: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("failed to check rows affected: %w", err)
	}
	return affected > 0, nil
}

func (r *sqliteSavedRepo) Delete(ctx context.Context, userID, id string) (bool, error) {
	result, err := r.db.ExecContext(ctx,
		`DELETE FROM saved_messages WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return false, fmt.Errorf("failed to delete saved message: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("failed to check rows affected: %w", err)
	}
	return affected > 0, nil
}
