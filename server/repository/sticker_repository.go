package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// StickerRepository is data access for the server_stickers table (migration
// 087) — per-server stickers. CreatedAt is always returned as RFC3339 UTC
// (dbTextToRFC3339), Tags is never nil. List methods return an empty,
// non-nil slice when nothing matches.
type StickerRepository interface {
	// CreateWithCap inserts s (s.ID, URL and AnimatedURL already set by the
	// caller) only while the server holds fewer than maxCount stickers (static
	// and animated together) — one atomic conditional INSERT, so concurrent
	// uploads cannot overshoot the cap. Fills s.CreatedAt from the DB
	// default. Returns models.ErrExpressionLimitReached when the cap is
	// full, pkg.ErrAlreadyExists (wrapped) on a UNIQUE violation.
	CreateWithCap(ctx context.Context, s *models.ServerSticker, maxCount int) error
	// GetByID returns the sticker with id in any server, or pkg.ErrNotFound.
	GetByID(ctx context.Context, id string) (*models.ServerSticker, error)
	// GetInServer returns sticker id only if it belongs to serverID,
	// otherwise pkg.ErrNotFound — another server's id is indistinguishable
	// from a missing one.
	GetInServer(ctx context.Context, serverID, id string) (*models.ServerSticker, error)
	// ListByServer returns serverID's stickers ordered by name.
	ListByServer(ctx context.Context, serverID string) ([]models.ServerSticker, error)
	// ListForUser returns the stickers of every server userID is a member
	// of, ordered by server_id then name.
	ListForUser(ctx context.Context, userID string) ([]models.ServerSticker, error)
	// CountByServer returns serverID's sticker count.
	CountByServer(ctx context.Context, serverID string) (int, error)
	// Update writes s.Name, s.DisplayName, s.Description, s.Tags and
	// s.Copyable for the row matching both s.ID and s.ServerID.
	// pkg.ErrNotFound when no row matched, pkg.ErrAlreadyExists (wrapped)
	// when the new name is taken.
	Update(ctx context.Context, s *models.ServerSticker) error
	// Delete removes sticker id of serverID; pkg.ErrNotFound when no row
	// matched.
	Delete(ctx context.Context, serverID, id string) error
}
