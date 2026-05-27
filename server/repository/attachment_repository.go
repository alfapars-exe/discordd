package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// AttachmentRepository defines data access for file attachments.
// GetByMessageIDs batch-loads attachments for multiple messages (avoids N+1).
// GetByFileURL backs the auth-gated /api/uploads/ download handler: the
// disk filename in the URL is mapped back to its owning message so the
// handler can verify the requester has access to that conversation.
type AttachmentRepository interface {
	Create(ctx context.Context, attachment *models.Attachment) error
	GetByMessageID(ctx context.Context, messageID string) ([]models.Attachment, error)
	GetByMessageIDs(ctx context.Context, messageIDs []string) ([]models.Attachment, error)
	GetByFileURL(ctx context.Context, fileURL string) (*models.Attachment, error)
	Delete(ctx context.Context, id string) error
}
