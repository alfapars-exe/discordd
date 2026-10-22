package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// MessageRepository defines data access for messages.
// GetByChannelID uses cursor-based pagination (beforeID + limit).
type MessageRepository interface {
	Create(ctx context.Context, message *models.Message) error
	GetByID(ctx context.Context, id string) (*models.Message, error)
	GetByChannelID(ctx context.Context, channelID string, beforeID string, limit int) ([]models.Message, error)
	// GetByChannelIDAround returns a window centred on anchorID: up to
	// limit/2 older rows, the anchor itself, and up to limit/2 newer rows, in
	// ASC order. hasMoreBefore/hasMoreAfter report whether rows exist beyond
	// either edge. The anchor is channel-scoped — an id from another channel
	// (or an unknown id) is pkg.ErrNotFound, never a page.
	GetByChannelIDAround(ctx context.Context, channelID, anchorID string, limit int) (msgs []models.Message, hasMoreBefore, hasMoreAfter bool, err error)
	// GetByChannelIDAfter returns up to limit rows strictly newer than
	// afterID (same (created_at, id) keyset as the before= form, mirrored),
	// in ASC order. Same channel-scoped anchor rule as GetByChannelIDAround.
	GetByChannelIDAfter(ctx context.Context, channelID, afterID string, limit int) ([]models.Message, error)
	Update(ctx context.Context, message *models.Message) error
	Delete(ctx context.Context, id string) error
}
