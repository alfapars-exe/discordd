package repository

import (
	"context"
	"time"

	"github.com/argeinfina/hichat/models"
)

// ChannelRepository defines data access for channels. All list operations are server-scoped.
type ChannelRepository interface {
	Create(ctx context.Context, channel *models.Channel) error
	GetByID(ctx context.Context, id string) (*models.Channel, error)
	GetAllByServer(ctx context.Context, serverID string) ([]models.Channel, error)
	GetByCategoryID(ctx context.Context, categoryID string) ([]models.Channel, error)
	GetThreadsByParent(ctx context.Context, parentChannelID string, includeArchived bool) ([]models.Channel, error)
	SetThreadArchived(ctx context.Context, threadID string, archived bool) error
	Update(ctx context.Context, channel *models.Channel) error
	Delete(ctx context.Context, id string) error
	GetMaxPosition(ctx context.Context, categoryID string) (int, error)
	// UpdatePositions atomically updates position values for multiple channels.
	UpdatePositions(ctx context.Context, items []models.PositionUpdate) error
	// GetFileURLsByChannelID returns every attachment file_url belonging to
	// messages in the given channel. Used by ChannelService.Delete to clean
	// up on-disk files before the channel (and its messages/attachments,
	// which cascade only where the DB actually enforces foreign keys) is
	// deleted — see services.removeUploadFilesByURL.
	GetFileURLsByChannelID(ctx context.Context, channelID string) ([]string, error)
}

// VoiceAccessReader provides same-snapshot admission/routing and audience reads.
type VoiceAccessReader interface {
	VoiceAdmission(context.Context, string, string) (*models.VoiceAdmission, error)
	VoiceTokenAccess(context.Context, string, string, time.Time) (*models.VoiceAdmission, *models.LiveKitInstance, int64, error)
	VoiceVisibleUsers(context.Context, string, string, []string) ([]string, error)
}

// ChannelStore declares optional backend-specific voice access at composition.
type ChannelStore interface {
	ChannelRepository
	VoiceAccess() VoiceAccessReader
}
