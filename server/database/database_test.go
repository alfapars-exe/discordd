package database

import (
	"database/sql"
	"io/fs"
	"path/filepath"
	"testing"
)

// newRunnerTestDB opens a throwaway local SQLite file (modernc driver, already
// registered via the blank import in database.go) and returns a *DB wrapping it.
// A file path — not :memory: — is used deliberately: the runner can hold several
// pooled connections, and each :memory: connection would see a *separate* DB.
func newRunnerTestDB(t *testing.T) *DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "runner_test.db")
	conn, err := sql.Open("sqlite", dbPath+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if err := conn.Ping(); err != nil {
		t.Fatalf("ping test db: %v", err)
	}
	return &DB{Conn: conn}
}

// applyMigrationFile inserts into schema_migrations, so it must exist first.
func mustCreateSchemaMigrations(t *testing.T, db *DB) {
	t.Helper()
	if _, err := db.Conn.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		filename TEXT PRIMARY KEY,
		applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		t.Fatalf("create schema_migrations: %v", err)
	}
}

func mustExec(t *testing.T, db *DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Conn.Exec(query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

func count(t *testing.T, db *DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.Conn.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	return n
}

func readEmbedded067(t *testing.T) string {
	t.Helper()
	content, err := fs.ReadFile(EmbeddedMigrations, "migrations/067_hashed_refresh_tokens.sql")
	if err != nil {
		t.Fatalf("read embedded migration 067: %v", err)
	}
	return string(content)
}

// TestApplyMigrationFile_RollsBackEntireFileOnError is the generalized P0-BD-03
// guarantee: a migration that fails partway through must leave NOTHING behind.
// If applyMigrationFile committed per statement (the old, pre-transactional
// behavior), atomic_probe would survive and this test would fail.
func TestApplyMigrationFile_RollsBackEntireFileOnError(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	// Statement 1 & 2 succeed; statement 3 fails with a non-recoverable error.
	content := "CREATE TABLE atomic_probe (id INTEGER PRIMARY KEY);\n" +
		"INSERT INTO atomic_probe (id) VALUES (1);\n" +
		"INSERT INTO atomic_probe (nonexistent_col) VALUES (2);"

	if err := db.applyMigrationFile("900_atomic_probe.sql", content); err == nil {
		t.Fatal("expected applyMigrationFile to fail on the invalid statement")
	}

	if n := count(t, db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='atomic_probe'"); n != 0 {
		t.Fatalf("atomic_probe survived a failed migration (n=%d) — migration is NOT atomic", n)
	}
	if n := count(t, db, "SELECT COUNT(*) FROM schema_migrations WHERE filename='900_atomic_probe.sql'"); n != 0 {
		t.Fatalf("a failed migration must not be recorded as applied, found %d", n)
	}
}

// TestMigration067_DeletesPlaintextRefreshTokens runs the REAL migration 067
// against a sessions table seeded with plaintext refresh tokens and asserts none
// survive — the exact property audit finding P0-BD-03 worries about.
func TestMigration067_DeletesPlaintextRefreshTokens(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	mustExec(t, db, `CREATE TABLE sessions (id INTEGER PRIMARY KEY, refresh_token TEXT NOT NULL)`)
	mustExec(t, db, `INSERT INTO sessions (refresh_token) VALUES ('plaintext-a'), ('plaintext-b')`)

	// Precondition (guards against a vacuously-passing test).
	if n := count(t, db, "SELECT COUNT(*) FROM sessions WHERE refresh_token IS NOT NULL"); n != 2 {
		t.Fatalf("setup: expected 2 plaintext rows, got %d", n)
	}

	if err := db.applyMigrationFile("067_hashed_refresh_tokens.sql", readEmbedded067(t)); err != nil {
		t.Fatalf("apply migration 067: %v", err)
	}

	if n := count(t, db, "SELECT COUNT(*) FROM sessions WHERE refresh_token IS NOT NULL"); n != 0 {
		t.Fatalf("P0-BD-03: %d plaintext refresh_token row(s) survived migration 067", n)
	}
	// The hash column exists (selecting it must not error)...
	if _, err := db.Conn.Exec("SELECT refresh_token_hash FROM sessions LIMIT 0"); err != nil {
		t.Fatalf("refresh_token_hash column missing after 067: %v", err)
	}
	// ...and so does its unique index.
	if n := count(t, db, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_sessions_refresh_token_hash'"); n != 1 {
		t.Fatalf("expected idx_sessions_refresh_token_hash after 067, found %d", n)
	}
}

// TestMigration067_HealsLegacyPartialApply simulates a pre-transactional partial
// apply: the ALTER already committed (column present) but the DELETE never ran
// and 067 was never recorded. Re-running 067 must TOLERATE the duplicate column
// and still run the DELETE — i.e. self-heal rather than crash forever. This is
// the concrete answer to P0-BD-03's "partial-failure window".
func TestMigration067_HealsLegacyPartialApply(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	mustExec(t, db, `CREATE TABLE sessions (id INTEGER PRIMARY KEY, refresh_token TEXT NOT NULL, refresh_token_hash TEXT)`)
	mustExec(t, db, `INSERT INTO sessions (refresh_token) VALUES ('leftover-plaintext')`)

	if n := count(t, db, "SELECT COUNT(*) FROM sessions WHERE refresh_token IS NOT NULL"); n != 1 {
		t.Fatalf("setup: expected 1 leftover plaintext row, got %d", n)
	}

	if err := db.applyMigrationFile("067_hashed_refresh_tokens.sql", readEmbedded067(t)); err != nil {
		t.Fatalf("067 should heal a partial apply (tolerate duplicate column), got: %v", err)
	}

	if n := count(t, db, "SELECT COUNT(*) FROM sessions WHERE refresh_token IS NOT NULL"); n != 0 {
		t.Fatalf("legacy plaintext refresh token not cleared on re-run: %d", n)
	}
}

// TestAllMigrationsApplyCleanly applies the entire embedded migration set to a
// fresh DB through the real runner — a boot smoke test that catches a broken
// or mis-ordered migration (e.g. the new 070) before it reaches production,
// where the Go server otherwise can't be compiled/run on Windows.
func TestAllMigrationsApplyCleanly(t *testing.T) {
	sub, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("sub fs: %v", err)
	}
	dbPath := filepath.Join(t.TempDir(), "migrate_all.db")
	db, err := New(dbPath, sub)
	if err != nil {
		t.Fatalf("embedded migrations failed to apply on a fresh DB: %v", err)
	}
	defer db.Close()

	// Migration 070 (P0-BD-01) must have added the integrity-MAC column.
	if _, err := db.Conn.Exec("SELECT backup_hmac FROM e2ee_key_backups LIMIT 0"); err != nil {
		t.Fatalf("expected backup_hmac column after migration 070: %v", err)
	}
}
