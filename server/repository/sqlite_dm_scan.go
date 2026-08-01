package repository

// Row-scan helpers for DM message queries.

import (
	"database/sql"
	"fmt"

	"github.com/argeinfina/hichat/models"
)

// scanDMMessageRow parses a standard DM message query row including author and reply reference.
//
// The author columns come back through NullStrings because the users LEFT JOIN
// can legitimately produce no row (a dangling user_id), in which case ALL of
// them are NULL — not just the id. A NULL scanned into a plain string fails the
// row, and every DM listing/pin/search path funnels through here, so one
// authorless message would fail the whole page instead of only itself. Mirrors
// scanMessage in sqlite_message.go.
func scanDMMessageRow(rows *sql.Rows) (*models.DMMessage, error) {
	var msg models.DMMessage
	var author models.PublicUser
	var authorID, authorUsername, authorStatus sql.NullString
	var authorCreatedAt sql.NullTime
	var content sql.NullString
	var editedAt sql.NullTime
	var displayName, avatarURL, customStatus sql.NullString
	var isPinned int

	var refMsgID, refMsgContent sql.NullString
	var refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL, refAuthorCustomStatus sql.NullString
	var refAuthorCreatedAt sql.NullTime

	if err := rows.Scan(
		&msg.ID, &msg.DMChannelID, &msg.UserID, &content, &editedAt, &msg.CreatedAt,
		&msg.ReplyToID, &isPinned,
		&msg.EncryptionVersion, &msg.Ciphertext, &msg.SenderDeviceID, &msg.E2EEMetadata,
		&authorID, &authorUsername, &displayName, &avatarURL, &authorStatus, &customStatus, &authorCreatedAt,
		&refMsgID, &refMsgContent,
		&refAuthorID, &refAuthorUsername, &refAuthorDisplayName, &refAuthorAvatarURL, &refAuthorCustomStatus, &refAuthorCreatedAt,
	); err != nil {
		return nil, fmt.Errorf("failed to scan DM message: %w", err)
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
