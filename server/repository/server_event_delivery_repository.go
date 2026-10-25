package repository

import (
	"context"
	"time"

	"github.com/argeinfina/hichat/models"
)

// ServerEventDeliveryRepository selects events entering their notification
// window and transactionally delivers an event notice to an eligible user.
// Deliver returns nil,nil when the event or recipient is no longer eligible,
// or when this event/user/schedule has already been delivered.
type ServerEventDeliveryRepository interface {
	DueCandidates(context.Context, time.Time, int, string) ([]models.ServerEvent, error)
	InterestedPage(context.Context, string, string, int) ([]string, error)
	Deliver(context.Context, string, int64, string, time.Time) (*models.Notification, error)
}
