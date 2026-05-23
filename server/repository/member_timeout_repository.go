package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// MemberTimeoutRepository — persistence for moderator-imposed timeouts.
// All read methods filter out expired rows so the service layer never
// has to compare timestamps itself — an expired timeout is invisible.
type MemberTimeoutRepository interface {
	// Upsert applies or extends a timeout. Re-issuing on an already
	// timed-out user overwrites expires_at, applied_by, and reason
	// (PRIMARY KEY is (server_id, user_id)).
	Upsert(ctx context.Context, t *models.MemberTimeout) error
	// Get returns the active timeout for (server, user), or nil if the
	// user is not currently timed out.
	Get(ctx context.Context, serverID, userID string) (*models.MemberTimeout, error)
	// Delete lifts the timeout. No-op if the row didn't exist.
	Delete(ctx context.Context, serverID, userID string) error
	// IsActive — fast existence check used on the hot paths
	// (SendMessage, JoinChannel). Equivalent to Get(...) != nil but
	// cheaper because it doesn't allocate.
	IsActive(ctx context.Context, serverID, userID string) (bool, error)
}
