package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// ServerEventRepository persists server-wide events and their interested
// RSVPs. Authorization and channel-visibility checks belong to the service.
type ServerEventRepository interface {
	Create(context.Context, *models.ServerEvent) error
	GetByID(context.Context, string, string) (*models.ServerEvent, error)
	// List orders by starts_at, id ascending. beforeID is a server-scoped
	// keyset cursor; an unknown/foreign cursor produces an empty page.
	List(context.Context, string, int, string) ([]models.ServerEvent, error)
	// UpdateCAS updates a scheduled event only when its version matches and
	// increments that version. False means stale, missing, or already cancelled.
	UpdateCAS(context.Context, *models.ServerEvent, int64) (bool, error)
	CancelCAS(context.Context, string, string, int64) (bool, error)
	// SetInterested(true) idempotently creates/refreshes the RSVP; false removes it.
	SetInterested(context.Context, string, string, bool) error
	IsInterested(context.Context, string, string) (bool, error)
	InterestedUserIDs(context.Context, string) ([]string, error)
}
