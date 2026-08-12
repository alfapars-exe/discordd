// P3.11: RuntimeTelemetryRepository round-trip through the production repo
// (not hand-written SQL) — the migration-level tests (database package)
// cover the schema; this covers the repo's query correctness against it.
package repository

import (
	"context"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

func TestSQLiteRuntimeTelemetryRepo_InsertPurgeOlderThan(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteRuntimeTelemetryRepo(db.Conn)
	ctx := context.Background()

	old := &models.RuntimeTelemetry{
		BucketAt:              "2020-01-01 00:00:00",
		Goroutines:            10,
		HeapAllocBytes:        1000,
		OnlineUsers:           5,
		DBOpenConns:           3,
		DBInUse:               1,
		DBIdle:                2,
		DBWaitCount:           0,
		WSDispatchTotal:       100,
		WSRateLimitDropsTotal: 1,
		HTTPRequests:          50,
		HTTP5xx:               0,
		HTTPMaxLatencyMs:      120,
		HTTPAvgLatencyMs:      12.5,
	}
	fresh := &models.RuntimeTelemetry{
		BucketAt:              "2099-01-01 00:00:00",
		Goroutines:            11,
		HeapAllocBytes:        2000,
		OnlineUsers:           6,
		WSDispatchTotal:       200,
		WSRateLimitDropsTotal: 2,
		HTTPRequests:          60,
		HTTPMaxLatencyMs:      80,
		HTTPAvgLatencyMs:      8.5,
	}

	if err := repo.Insert(ctx, old); err != nil {
		t.Fatalf("insert old row: %v", err)
	}
	if err := repo.Insert(ctx, fresh); err != nil {
		t.Fatalf("insert fresh row: %v", err)
	}

	if got := countRows(t, db, `SELECT COUNT(*) FROM runtime_telemetry`); got != 2 {
		t.Fatalf("row count after inserts = %d, want 2", got)
	}

	cutoff, err := time.Parse("2006-01-02 15:04:05", "2050-01-01 00:00:00")
	if err != nil {
		t.Fatalf("parse cutoff: %v", err)
	}

	deleted, err := repo.PurgeOlderThan(ctx, cutoff)
	if err != nil {
		t.Fatalf("PurgeOlderThan: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1 (only the 2020 row)", deleted)
	}

	if got := countRows(t, db, `SELECT COUNT(*) FROM runtime_telemetry WHERE bucket_at = ?`, old.BucketAt); got != 0 {
		t.Error("old row survived PurgeOlderThan")
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM runtime_telemetry WHERE bucket_at = ?`, fresh.BucketAt); got != 1 {
		t.Error("fresh row was incorrectly purged")
	}
}

// TestSQLiteRuntimeTelemetryRepo_InsertReplacesSameBucket — bucket_at is the
// primary key; a second Insert for the same minute (e.g. a restart landing
// on the same bucket as the previous process's last tick) must replace, not
// error with a UNIQUE constraint violation.
func TestSQLiteRuntimeTelemetryRepo_InsertReplacesSameBucket(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteRuntimeTelemetryRepo(db.Conn)
	ctx := context.Background()

	const bucket = "2030-06-15 12:34:00"
	if err := repo.Insert(ctx, &models.RuntimeTelemetry{BucketAt: bucket, Goroutines: 1}); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	if err := repo.Insert(ctx, &models.RuntimeTelemetry{BucketAt: bucket, Goroutines: 99}); err != nil {
		t.Fatalf("second insert for the same bucket: %v", err)
	}

	if got := countRows(t, db, `SELECT COUNT(*) FROM runtime_telemetry WHERE bucket_at = ?`, bucket); got != 1 {
		t.Fatalf("row count for bucket = %d, want 1 (replaced, not duplicated)", got)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM runtime_telemetry WHERE bucket_at = ? AND goroutines = 99`, bucket); got != 1 {
		t.Error("second insert's value did not win — REPLACE semantics broken")
	}
}
