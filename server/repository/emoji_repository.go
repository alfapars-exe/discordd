package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// EmojiRepository is data access for the server_emojis table (migration
// 086) — per-server custom emojis. CreatedAt is always returned as RFC3339
// UTC (dbTextToRFC3339). List methods return an empty, non-nil slice when
// nothing matches.
type EmojiRepository interface {
	// CreateWithCap inserts e (e.ID, URL and AnimatedURL already set by the
	// caller) only while the server holds fewer than maxForType emojis of
	// e.Animated's type — one atomic conditional INSERT, so concurrent
	// uploads cannot overshoot the cap. Fills e.CreatedAt from the DB
	// default. Returns models.ErrExpressionLimitReached when the cap is
	// full, pkg.ErrAlreadyExists (wrapped) on a UNIQUE violation.
	CreateWithCap(ctx context.Context, e *models.ServerEmoji, maxForType int) error
	// GetByID returns the emoji with id in any server, or pkg.ErrNotFound.
	GetByID(ctx context.Context, id string) (*models.ServerEmoji, error)
	// GetInServer returns emoji id only if it belongs to serverID, otherwise
	// pkg.ErrNotFound — another server's id is indistinguishable from a
	// missing one.
	GetInServer(ctx context.Context, serverID, id string) (*models.ServerEmoji, error)
	// ListByServer returns serverID's emojis ordered by name.
	ListByServer(ctx context.Context, serverID string) ([]models.ServerEmoji, error)
	// ListForUser returns the emojis of every server userID is a member of,
	// ordered by server_id then name.
	ListForUser(ctx context.Context, userID string) ([]models.ServerEmoji, error)
	// CountByServer returns serverID's static and animated emoji counts.
	CountByServer(ctx context.Context, serverID string) (static, animated int, err error)
	// Update writes e.Name, e.DisplayName and e.Copyable for the row matching
	// both e.ID and e.ServerID. pkg.ErrNotFound when no row matched,
	// pkg.ErrAlreadyExists (wrapped) when the new name is taken.
	Update(ctx context.Context, e *models.ServerEmoji) error
	// Delete removes emoji id of serverID; pkg.ErrNotFound when no row matched.
	Delete(ctx context.Context, serverID, id string) error
}
