package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/argeinfina/hichat/pkg"
)

const (
	// SavedMessagesLimit caps bookmarks per user; POST past it is a 400
	// "saved_limit_reached".
	SavedMessagesLimit = 500
	// NoteMaxRunes bounds saved-message notes and per-user notes alike.
	NoteMaxRunes = 1024
	// SavedPageDefault / SavedPageMax bound GET /api/users/me/saved?limit —
	// the handler clamps into this range.
	SavedPageDefault = 20
	SavedPageMax     = 50
)

// SavedMessage is one saved_messages row (migration 083) with the referenced
// message hydrated through LEFT JOINs. For a readable bookmark exactly one of
// Message / DMMessage is non-nil (mirroring the table's CHECK) and
// Unavailable is false.
//
// Unavailable is true — and Message / DMMessage are both nil — when the
// referenced message is gone (the Turso-unenforced cascade did not fire) or
// the caller can no longer read it (lost channel access). The row is still
// returned as this stub so the user can see and delete it; only its own
// columns (id, note, ids, created_at) are exposed, never the content.
//
// CreatedAt is RFC3339 UTC text (the DB stores 'YYYY-MM-DD HH:MM:SS'; the
// repository converts on read) — a string, not time.Time, because the keyset
// cursor is resolved SQL-side against the raw stored column.
type SavedMessage struct {
	ID          string               `json:"id"`
	UserID      string               `json:"user_id"`
	Note        *string              `json:"note"`
	CreatedAt   string               `json:"created_at"`
	MessageID   *string              `json:"message_id"`
	DMMessageID *string              `json:"dm_message_id"`
	Message     *SavedChannelMessage `json:"message"`
	DMMessage   *SavedDMMessage      `json:"dm_message"`
	Unavailable bool                 `json:"unavailable"`
}

// AsUnavailable strips the referenced message from s and marks it as the
// unavailable stub (see SavedMessage).
func (s *SavedMessage) AsUnavailable() {
	s.Message = nil
	s.DMMessage = nil
	s.Unavailable = true
}

// SavedChannelMessage is the bookmark view of a channel message: enough to
// render a preview and deep-link (server/channel ids + names), never the
// full attachment/reaction/mention graph. E2EE bodies stay opaque — Content
// is nil and Ciphertext carries the blob, exactly as on Message.
type SavedChannelMessage struct {
	ID                string      `json:"id"`
	ChannelID         string      `json:"channel_id"`
	ServerID          string      `json:"server_id"`
	ChannelName       string      `json:"channel_name"`
	ServerName        string      `json:"server_name"`
	UserID            string      `json:"user_id"`
	Content           *string     `json:"content"`
	EncryptionVersion int         `json:"encryption_version"`
	Ciphertext        *string     `json:"ciphertext,omitempty"`
	SenderDeviceID    *string     `json:"sender_device_id,omitempty"`
	E2EEMetadata      *string     `json:"e2ee_metadata,omitempty"`
	CreatedAt         time.Time   `json:"created_at"`
	AttachmentCount   int         `json:"attachment_count"`
	Author            *PublicUser `json:"author"`
}

// SavedDMMessage is the DM counterpart of SavedChannelMessage.
type SavedDMMessage struct {
	ID                string      `json:"id"`
	DMChannelID       string      `json:"dm_channel_id"`
	UserID            string      `json:"user_id"`
	Content           *string     `json:"content"`
	EncryptionVersion int         `json:"encryption_version"`
	Ciphertext        *string     `json:"ciphertext,omitempty"`
	SenderDeviceID    *string     `json:"sender_device_id,omitempty"`
	E2EEMetadata      *string     `json:"e2ee_metadata,omitempty"`
	CreatedAt         time.Time   `json:"created_at"`
	AttachmentCount   int         `json:"attachment_count"`
	Author            *PublicUser `json:"author"`
}

// SavedMessagePage is the GET /api/users/me/saved response. HasMore and
// NextBefore are computed from the raw rows the repository returned:
// NextBefore is the id of the page's last row (pass it as ?before= for the
// next page) and is nil when HasMore is false.
type SavedMessagePage struct {
	Saved      []SavedMessage `json:"saved"`
	HasMore    bool           `json:"has_more"`
	NextBefore *string        `json:"next_before"`
}

// SavedMessageIDs is the GET /api/users/me/saved/ids response — the ids the
// caller has bookmarked, so the client can paint the bookmark state on a
// message list without fetching every saved row.
type SavedMessageIDs struct {
	MessageIDs   []string `json:"message_ids"`
	DMMessageIDs []string `json:"dm_message_ids"`
}

// CreateSavedMessageRequest is the POST /api/users/me/saved body. Exactly
// one of MessageID / DMMessageID must be set.
type CreateSavedMessageRequest struct {
	MessageID   string  `json:"message_id"`
	DMMessageID string  `json:"dm_message_id"`
	Note        *string `json:"note"`
}

// UpdateSavedNoteRequest is the PATCH /api/users/me/saved/{id} body. A null
// or empty note clears the stored note (NULL).
type UpdateSavedNoteRequest struct {
	Note *string `json:"note"`
}

// NormalizeNote prepares free-text note input (saved-message notes and
// per-user notes) for storage: CRLF is normalised to LF (every "\r"
// stripped), surrounding whitespace trimmed, then the text is bounded to
// NoteMaxRunes and rejected if it still carries a steering character
// (see pkg.ContainsSteeringCharsMultiline for why newline/tab are the only
// control characters allowed through). Returns pkg.ErrBadRequest-wrapped
// errors so services can pass them straight up to the handler.
func NormalizeNote(s string) (string, error) {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\r", ""))
	if utf8.RuneCountInString(s) > NoteMaxRunes {
		return "", fmt.Errorf("%w: note must be at most %d characters", pkg.ErrBadRequest, NoteMaxRunes)
	}
	if pkg.ContainsSteeringCharsMultiline(s) {
		return "", fmt.Errorf("%w: note contains invalid control characters", pkg.ErrBadRequest)
	}
	return s, nil
}
