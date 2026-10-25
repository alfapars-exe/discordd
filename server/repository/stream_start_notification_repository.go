package repository

import (
	"context"
	"time"

	"github.com/argeinfina/hichat/models"
)

// StreamStartNotificationRepository lists a bounded set of server members
// who are accepted friends of a stream publisher and transactionally records
// each recipient's consent/eligibility decision and optional inbox notice.
type StreamStartNotificationRepository interface {
	DueRecipients(ctx context.Context, publicationID, serverID, actorID string, limit int) ([]string, error)
	Deliver(ctx context.Context, publicationID, roomName, trackSID, serverID, channelID, actorID, recipientID string, now time.Time) (*models.Notification, error)
}
