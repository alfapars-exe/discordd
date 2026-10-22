package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// SavedRepository is data access for the saved_messages table (migration
// 083) — per-user bookmarks of channel or DM messages.
//
// Every read returns rows with the referenced message hydrated (LEFT JOIN
// on messages/dm_messages, their authors, and the owning channel/server for
// channel messages). A row whose reference row is gone on both sides —
// possible on Turso, where the declared ON DELETE CASCADE never fires — is
// returned as the unavailable stub (models.SavedMessage.Unavailable) rather
// than skipped, so the user can still see and delete it and page sizes match
// the raw row count; the owning delete paths (server cascade, channel/message
// deletes, startup repair) remove such rows explicitly.
type SavedRepository interface {
	// Create inserts s, assigning s.ID (generateID) and filling s.CreatedAt
	// from the DB default. Exactly one of s.MessageID / s.DMMessageID must be
	// set (the table's CHECK enforces it); a duplicate (user, message) pair
	// fails with the UNIQUE violation.
	Create(ctx context.Context, s *models.SavedMessage) error
	// GetByID returns one hydrated row the user owns, or pkg.ErrNotFound when
	// no such row exists OR it is not theirs (deliberately indistinguishable).
	GetByID(ctx context.Context, userID, id string) (*models.SavedMessage, error)
	// FindByRef returns the user's existing bookmark of the given channel
	// message (messageID) or DM message (dmMessageID) — one of the two is
	// empty — or (nil, nil) when none exists.
	FindByRef(ctx context.Context, userID, messageID, dmMessageID string) (*models.SavedMessage, error)
	// List returns userID's bookmarks newest-first (created_at DESC, id
	// DESC), at most limit rows. beforeID is a keyset cursor scoped to the
	// caller's own rows: a foreign or unknown id yields an empty page.
	List(ctx context.Context, userID, beforeID string, limit int) ([]models.SavedMessage, error)
	// ListIDs returns every message_id and dm_message_id the user has
	// bookmarked (both slices non-nil).
	ListIDs(ctx context.Context, userID string) (messageIDs, dmMessageIDs []string, err error)
	Count(ctx context.Context, userID string) (int, error)
	// UpdateNote sets note (nil clears it) on one row the user owns. Returns
	// false when no row matched — not found OR not owned.
	UpdateNote(ctx context.Context, userID, id string, note *string) (bool, error)
	// Delete removes one row the user owns. Returns false when no row matched.
	Delete(ctx context.Context, userID, id string) (bool, error)
}
