package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// AuditLogRepository — data access for server-scoped moderation event history.
type AuditLogRepository interface {
	Insert(ctx context.Context, entry *models.AuditLog) error
	// ListByServer returns audit entries for a server, newest first.
	// Pagination uses a cursor on (created_at, id) to break timestamp ties.
	ListByServer(ctx context.Context, filter models.AuditLogFilter) ([]models.AuditLog, error)
}
