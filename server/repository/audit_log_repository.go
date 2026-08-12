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
	// DeleteBefore removes rows with created_at older than before (same
	// "2006-01-02 15:04:05" SQLite text format as AppLogRepository.DeleteBefore)
	// and returns the number of rows deleted. Backs the retention auto-purge.
	DeleteBefore(ctx context.Context, before string) (int64, error)
}
