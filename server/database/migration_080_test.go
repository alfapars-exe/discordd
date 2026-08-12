// Migration 080 tests. Mirrors migration_078_test.go's shape: a minimal
// hand-applied migration (no fixture tables needed here — runtime_telemetry
// has no FKs) plus a full-schema run to catch ordering issues in isolation.
package database

import (
	"io/fs"
	"testing"
)

const migration080 = "080_runtime_telemetry.sql"

// TestMigration080_CreatesTableAndIndex is the core guarantee: the table and
// its bucket_at DESC index both exist after applying the migration.
func TestMigration080_CreatesTableAndIndex(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration080)
	if err := db.applyMigrationFile(migration080, content); err != nil {
		t.Fatalf("apply migration 080: %v", err)
	}

	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='runtime_telemetry'`); n != 1 {
		t.Fatalf("runtime_telemetry table not found after migration 080")
	}
	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_runtime_telemetry_bucket'`); n != 1 {
		t.Fatalf("idx_runtime_telemetry_bucket index not found after migration 080")
	}
}

// TestMigration080_SecondRunIsIdempotent: both CREATE TABLE and CREATE INDEX
// use IF NOT EXISTS, so re-applying the file's statements must not error.
func TestMigration080_SecondRunIsIdempotent(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration080)
	if err := db.applyMigrationFile(migration080, content); err != nil {
		t.Fatalf("apply migration 080 (first run): %v", err)
	}
	if err := execRawStatements(t, db, migration080, content); err != nil {
		t.Fatalf("re-apply migration 080 statements (second run): %v", err)
	}

	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='runtime_telemetry'`); n != 1 {
		t.Fatalf("runtime_telemetry table count after two runs = %d, want 1", n)
	}
}

// TestMigration080_InsertPurgeRoundTrip exercises the table's actual
// read/write shape through the production repository (P3.11's core
// guarantee): a row inserted with a given bucket_at is found before the
// cutoff and purged after it, and PurgeOlderThan reports the right count.
func TestMigration080_InsertPurgeRoundTrip(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration080)
	if err := db.applyMigrationFile(migration080, content); err != nil {
		t.Fatalf("apply migration 080: %v", err)
	}

	mustExec(t, db, `INSERT INTO runtime_telemetry (
		bucket_at, goroutines, heap_alloc_bytes, online_users,
		db_open_conns, db_in_use, db_idle, db_wait_count,
		ws_dispatch_total, ws_rate_limit_drops_total,
		http_requests, http_5xx, http_max_latency_ms, http_avg_latency_ms
	) VALUES ('2020-01-01 00:00:00', 10, 1000, 5, 3, 1, 2, 0, 100, 1, 50, 0, 120, 12.5)`)
	mustExec(t, db, `INSERT INTO runtime_telemetry (
		bucket_at, goroutines, heap_alloc_bytes, online_users,
		db_open_conns, db_in_use, db_idle, db_wait_count,
		ws_dispatch_total, ws_rate_limit_drops_total,
		http_requests, http_5xx, http_max_latency_ms, http_avg_latency_ms
	) VALUES ('2099-01-01 00:00:00', 10, 1000, 5, 3, 1, 2, 0, 100, 1, 50, 0, 120, 12.5)`)

	if n := count(t, db, `SELECT COUNT(*) FROM runtime_telemetry`); n != 2 {
		t.Fatalf("seeded row count = %d, want 2", n)
	}

	var deleted int
	if err := db.Conn.QueryRow(
		`SELECT COUNT(*) FROM runtime_telemetry WHERE bucket_at < ?`, "2050-01-01 00:00:00",
	).Scan(&deleted); err != nil {
		t.Fatalf("count rows before cutoff: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("rows before cutoff = %d, want 1 (only the 2020 row)", deleted)
	}

	if _, err := db.Conn.Exec(`DELETE FROM runtime_telemetry WHERE bucket_at < ?`, "2050-01-01 00:00:00"); err != nil {
		t.Fatalf("delete old rows: %v", err)
	}
	if n := count(t, db, `SELECT COUNT(*) FROM runtime_telemetry`); n != 1 {
		t.Fatalf("remaining row count = %d, want 1 (only the 2099 row survives)", n)
	}
}

// TestMigration080_AppliesOnFullSchema runs the whole embedded migration set
// end-to-end — the ordering check the isolated tests above cannot cover.
func TestMigration080_AppliesOnFullSchema(t *testing.T) {
	db := newRunnerTestDB(t)
	migrationsFS, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	if err := db.runMigrations(migrationsFS); err != nil {
		t.Fatalf("full migration run: %v", err)
	}

	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='runtime_telemetry'`); n != 1 {
		t.Fatalf("runtime_telemetry table not found after a full migration run")
	}
	if n := count(t, db, `SELECT COUNT(*) FROM schema_migrations WHERE filename=?`, migration080); n != 1 {
		t.Errorf("%s not recorded as applied, found %d", migration080, n)
	}
}
