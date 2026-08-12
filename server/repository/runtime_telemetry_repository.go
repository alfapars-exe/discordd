package repository

import (
	"context"
	"time"

	"github.com/argeinfina/hichat/models"
)

// RuntimeTelemetryRepository defines data access for the durable runtime
// telemetry rollup (P3.11) — see models.RuntimeTelemetry.
type RuntimeTelemetryRepository interface {
	// Insert saves one minute-bucketed row. Called once per tick by
	// startRuntimeStatsLogger (health.go).
	Insert(ctx context.Context, row *models.RuntimeTelemetry) error
	// PurgeOlderThan deletes rows with bucket_at before the given time.
	// Returns the number of rows deleted.
	PurgeOlderThan(ctx context.Context, before time.Time) (int64, error)
}
