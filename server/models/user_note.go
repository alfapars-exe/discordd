package models

// UserNote is the caller's private note about another user (user_notes,
// migration 084), as served by GET/PUT /api/users/{userId}/note. A user
// with no stored note reads as {note: "", updated_at: null}; UpdatedAt is
// RFC3339 UTC text when a row exists (the DB stores 'YYYY-MM-DD HH:MM:SS').
type UserNote struct {
	Note      string  `json:"note"`
	UpdatedAt *string `json:"updated_at"`
}

// UpsertUserNoteRequest is the PUT /api/users/{userId}/note body. An empty
// note (after NormalizeNote) deletes the row.
type UpsertUserNoteRequest struct {
	Note string `json:"note"`
}
