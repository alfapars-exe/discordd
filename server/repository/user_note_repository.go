package repository

import "context"

// UserNoteRepository is data access for the user_notes table (migration
// 084): the caller's private note about another user, keyed by
// (owner_user_id, target_user_id).
type UserNoteRepository interface {
	// Get returns the stored note and its updated_at (RFC3339 UTC), or
	// ("", nil, nil) when the owner has no note about target.
	Get(ctx context.Context, ownerUserID, targetUserID string) (note string, updatedAt *string, err error)
	// Upsert stores note for the pair (insert or replace) and returns the
	// resulting updated_at (RFC3339 UTC).
	Upsert(ctx context.Context, ownerUserID, targetUserID, note string) (updatedAt string, err error)
	// Delete removes the pair's note; a missing row is not an error.
	Delete(ctx context.Context, ownerUserID, targetUserID string) error
}
