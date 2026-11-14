package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// AppLogRepository defines data access for structured app logs.
type AppLogRepository interface {
	Insert(ctx context.Context, log *models.AppLog) error
	List(ctx context.Context, filter models.AppLogFilter) ([]models.AppLog, int, error)
	DeleteBefore(ctx context.Context, before string) (int64, error)
	DeleteAll(ctx context.Context) error
}

type AppLogBatchWriter interface {
	InsertBatch(context.Context, []models.AppLog) (int64, error)
}

// AppLogStore retains optional production batching at composition.
type AppLogStore interface {
	AppLogRepository
	AppLogBatchWriter
}
