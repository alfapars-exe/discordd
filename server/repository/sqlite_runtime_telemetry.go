package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type sqliteRuntimeTelemetryRepo struct {
	db database.TxQuerier
}

func NewSQLiteRuntimeTelemetryRepo(db database.TxQuerier) RuntimeTelemetryRepository {
	return &sqliteRuntimeTelemetryRepo{db: db}
}

func (r *sqliteRuntimeTelemetryRepo) Insert(ctx context.Context, row *models.RuntimeTelemetry) error {
	// bucket_at is the primary key: a REPLACE (not a bare INSERT) tolerates
	// startRuntimeStatsLogger firing twice for the same minute — e.g. a
	// restart lands on the same minute boundary as the previous process's
	// last tick — without erroring on the UNIQUE violation.
	query := `
		INSERT OR REPLACE INTO runtime_telemetry (
			bucket_at, goroutines, heap_alloc_bytes, online_users,
			db_open_conns, db_in_use, db_idle, db_wait_count,
			ws_dispatch_total, ws_rate_limit_drops_total,
			http_requests, http_5xx, http_max_latency_ms, http_avg_latency_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	_, err := r.db.ExecContext(ctx, query,
		row.BucketAt, row.Goroutines, row.HeapAllocBytes, row.OnlineUsers,
		row.DBOpenConns, row.DBInUse, row.DBIdle, row.DBWaitCount,
		row.WSDispatchTotal, row.WSRateLimitDropsTotal,
		row.HTTPRequests, row.HTTP5xx, row.HTTPMaxLatencyMs, row.HTTPAvgLatencyMs,
	)
	if err != nil {
		return fmt.Errorf("failed to insert runtime telemetry: %w", err)
	}
	return nil
}

func (r *sqliteRuntimeTelemetryRepo) PurgeOlderThan(ctx context.Context, before time.Time) (int64, error) {
	query := `DELETE FROM runtime_telemetry WHERE bucket_at < ?`

	result, err := r.db.ExecContext(ctx, query, before.UTC().Format("2006-01-02 15:04:05"))
	if err != nil {
		return 0, fmt.Errorf("failed to purge old runtime telemetry: %w", err)
	}

	count, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("failed to get purge count: %w", err)
	}
	return count, nil
}
