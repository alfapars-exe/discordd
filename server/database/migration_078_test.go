// Migration 078 / 079 tests. 078 is a pure index-add (no data
// transformation); 079 rewrites custom badge icon URLs to move them behind
// the auth-hardened /api/uploads/ handler. Mirrors migration_072_test.go's
// shape: minimal hand-built fixture tables rather than running the whole
// migration chain, so each test is fast and isolated to the file under test.
package database

import (
	"io/fs"
	"testing"
)

const migration078 = "078_media_lookup_indexes.sql"
const migration079 = "079_badge_icon_api_prefix.sql"

// wantIndexes078 are the six indexes 078 must create.
var wantIndexes078 = []string{
	"idx_report_attachments_file_url",
	"idx_feedback_attachments_file_url",
	"idx_users_avatar_url",
	"idx_users_wallpaper_url",
	"idx_servers_icon_url",
	"idx_servers_banner_url",
}

// seedMediaLookupTables builds only the columns 078's indexes target —
// enough for CREATE INDEX to succeed without pulling in the full schema.
func seedMediaLookupTables(t *testing.T, db *DB) {
	t.Helper()
	stmts := []string{
		`CREATE TABLE report_attachments (id TEXT PRIMARY KEY, file_url TEXT NOT NULL)`,
		`CREATE TABLE feedback_attachments (id TEXT PRIMARY KEY, file_url TEXT NOT NULL)`,
		`CREATE TABLE users (id TEXT PRIMARY KEY, avatar_url TEXT, wallpaper_url TEXT)`,
		`CREATE TABLE servers (id TEXT PRIMARY KEY, icon_url TEXT, banner_url TEXT)`,
	}
	for _, s := range stmts {
		mustExec(t, db, s)
	}
}

// execRawStatements re-applies a migration file's SQL directly (bypassing
// schema_migrations bookkeeping, which has a filename PRIMARY KEY and would
// reject a second INSERT for the same file). This exercises the exact same
// statement-splitting / PRAGMA-skip path applyMigrationFile uses
// (execStatementsTx), so it's a faithful "run this file's SQL again" check.
func execRawStatements(t *testing.T, db *DB, filename, content string) error {
	t.Helper()
	tx, err := db.Conn.Begin()
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	if err := execStatementsTx(tx, filename, content); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func indexExists(t *testing.T, db *DB, name string) bool {
	t.Helper()
	return count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, name) == 1
}

// TestMigration078_CreatesAllSixIndexes is the core guarantee: every
// media-lookup index the migration declares actually gets created.
func TestMigration078_CreatesAllSixIndexes(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	seedMediaLookupTables(t, db)

	content := readEmbeddedMigration(t, migration078)
	if err := db.applyMigrationFile(migration078, content); err != nil {
		t.Fatalf("apply migration 078: %v", err)
	}

	for _, idx := range wantIndexes078 {
		if !indexExists(t, db, idx) {
			t.Errorf("expected index %s after 078, not found", idx)
		}
	}
}

// TestMigration078_SecondRunIsIdempotent: CREATE INDEX IF NOT EXISTS must
// tolerate being run twice against an already-indexed table (the same SQL
// re-applied, e.g. during local dev re-runs or a future migration replay).
func TestMigration078_SecondRunIsIdempotent(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	seedMediaLookupTables(t, db)

	content := readEmbeddedMigration(t, migration078)
	if err := db.applyMigrationFile(migration078, content); err != nil {
		t.Fatalf("apply migration 078 (first run): %v", err)
	}
	if err := execRawStatements(t, db, migration078, content); err != nil {
		t.Fatalf("re-apply migration 078 statements (second run): %v", err)
	}

	for _, idx := range wantIndexes078 {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); n != 1 {
			t.Errorf("index %s: expected exactly 1 after two runs, found %d", idx, n)
		}
	}
}

// seedBadgesTable builds the badges table shape from 040_badges.sql —
// enough columns for 079's UPDATE to exercise its WHERE clause.
func seedBadgesTable(t *testing.T, db *DB) {
	t.Helper()
	mustExec(t, db, `CREATE TABLE badges (
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		icon       TEXT NOT NULL DEFAULT '',
		icon_type  TEXT NOT NULL DEFAULT 'builtin' CHECK(icon_type IN ('builtin', 'custom')),
		color1     TEXT NOT NULL DEFAULT '#5865F2',
		color2     TEXT,
		created_by TEXT NOT NULL,
		created_at DATETIME NOT NULL DEFAULT (datetime('now'))
	)`)
}

func badgeIcon(t *testing.T, db *DB, id string) string {
	t.Helper()
	var icon string
	if err := db.Conn.QueryRow(`SELECT icon FROM badges WHERE id = ?`, id).Scan(&icon); err != nil {
		t.Fatalf("query badge %s icon: %v", id, err)
	}
	return icon
}

// TestMigration079_RewritesCustomBadgeIconPrefix is the core guarantee:
// only custom badges whose icon still points at the never-mounted
// /uploads/badges/ path get rewritten to the hardened /api/uploads/ path.
func TestMigration079_RewritesCustomBadgeIconPrefix(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	seedBadgesTable(t, db)

	mustExec(t, db, `INSERT INTO badges (id, name, icon, icon_type, created_by)
		VALUES ('b-custom', 'Custom', '/uploads/badges/x.png', 'custom', 'u1')`)
	// Builtin badges never used the /uploads/badges/ path — must be untouched.
	mustExec(t, db, `INSERT INTO badges (id, name, icon, icon_type, created_by)
		VALUES ('b-builtin', 'Builtin', 'star', 'builtin', 'u1')`)
	// A custom badge whose icon doesn't match the stale prefix (e.g. already
	// migrated, or an external URL) must also be left alone.
	mustExec(t, db, `INSERT INTO badges (id, name, icon, icon_type, created_by)
		VALUES ('b-custom-other', 'CustomOther', 'https://example.com/i.png', 'custom', 'u1')`)

	if err := db.applyMigrationFile(migration079, readEmbeddedMigration(t, migration079)); err != nil {
		t.Fatalf("apply migration 079: %v", err)
	}

	if got, want := badgeIcon(t, db, "b-custom"), "/api/uploads/badges/x.png"; got != want {
		t.Errorf("b-custom icon = %q, want %q", got, want)
	}
	if got, want := badgeIcon(t, db, "b-builtin"), "star"; got != want {
		t.Errorf("b-builtin icon = %q, want %q (builtin rows must not be touched)", got, want)
	}
	if got, want := badgeIcon(t, db, "b-custom-other"), "https://example.com/i.png"; got != want {
		t.Errorf("b-custom-other icon = %q, want %q (non-matching custom rows must not be touched)", got, want)
	}
}

// TestMigration079_SecondRunIsIdempotent: the UPDATE's WHERE clause matches
// the OLD '/uploads/badges/…' prefix, so a rewritten row no longer matches
// on a second pass — re-running must be a no-op, not a double "/api/api" prefix.
func TestMigration079_SecondRunIsIdempotent(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	seedBadgesTable(t, db)

	mustExec(t, db, `INSERT INTO badges (id, name, icon, icon_type, created_by)
		VALUES ('b-custom', 'Custom', '/uploads/badges/x.png', 'custom', 'u1')`)

	content := readEmbeddedMigration(t, migration079)
	if err := db.applyMigrationFile(migration079, content); err != nil {
		t.Fatalf("apply migration 079 (first run): %v", err)
	}
	if err := execRawStatements(t, db, migration079, content); err != nil {
		t.Fatalf("re-apply migration 079 statements (second run): %v", err)
	}

	if got, want := badgeIcon(t, db, "b-custom"), "/api/uploads/badges/x.png"; got != want {
		t.Errorf("b-custom icon after two runs = %q, want %q (no double prefix)", got, want)
	}
}

// TestMigrations078And079_ApplyOnFullSchema runs the whole embedded
// migration set end-to-end — the ordering/foreign-table check the isolated
// tests above cannot cover on their own.
func TestMigrations078And079_ApplyOnFullSchema(t *testing.T) {
	db := newRunnerTestDB(t)
	migrationsFS, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	if err := db.runMigrations(migrationsFS); err != nil {
		t.Fatalf("full migration run: %v", err)
	}

	for _, idx := range wantIndexes078 {
		if !indexExists(t, db, idx) {
			t.Errorf("expected index %s after a full migration run, not found", idx)
		}
	}
	for _, migration := range []string{migration078, migration079} {
		if n := count(t, db, `SELECT COUNT(*) FROM schema_migrations WHERE filename=?`, migration); n != 1 {
			t.Errorf("%s not recorded as applied, found %d", migration, n)
		}
	}
}
