// Migration 072 tests — attachments.file_url / dm_attachments.file_url must
// end up UNIQUE, and getting there must not lose the *first* upload's row.
// GetByFileURL resolves a download URL to a row with LIMIT 1 and uses that
// row's message_id for the access check, so a duplicate file_url makes an
// authorization decision depend on scan order.
package database

import (
	"io/fs"
	"strings"
	"testing"
)

// readEmbeddedMigration returns a migration file's contents from the embedded
// FS, so tests exercise the REAL SQL that ships rather than a copy.
func readEmbeddedMigration(t *testing.T, name string) string {
	t.Helper()
	content, err := fs.ReadFile(EmbeddedMigrations, "migrations/"+name)
	if err != nil {
		t.Fatalf("read embedded migration %s: %v", name, err)
	}
	return string(content)
}

const migration072 = "072_attachments_file_url_unique.sql"

// seedPre072Attachments builds the attachments / dm_attachments schema exactly
// as it stands *before* 072: column definitions from 001_init.sql and
// 009_dm.sql, plus the NON-unique lookup indexes added by 071. 072 has to
// cope with this shape on a real deployment.
func seedPre072Attachments(t *testing.T, db *DB) {
	t.Helper()
	stmts := []string{
		`CREATE TABLE attachments (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			filename TEXT NOT NULL,
			file_url TEXT NOT NULL,
			file_size INTEGER,
			mime_type TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE dm_attachments (
			id TEXT PRIMARY KEY,
			dm_message_id TEXT NOT NULL,
			filename TEXT NOT NULL,
			file_url TEXT NOT NULL,
			file_size INTEGER,
			mime_type TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX idx_attachments_file_url ON attachments(file_url)`,
		`CREATE INDEX idx_dm_attachments_file_url ON dm_attachments(file_url)`,
	}
	for _, s := range stmts {
		mustExec(t, db, s)
	}
}

// TestMigration072_DedupesAndEnforcesUniqueFileURL is the core guarantee:
// duplicates present before the migration collapse to exactly one row, and
// the database refuses to create a new duplicate afterwards.
func TestMigration072_DedupesAndEnforcesUniqueFileURL(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	seedPre072Attachments(t, db)

	// Two rows share /api/uploads/dead_beef_a.png; a third is distinct.
	// Insert order fixes rowid order, so "first" is unambiguous.
	mustExec(t, db, `INSERT INTO attachments (id, message_id, filename, file_url)
		VALUES ('att-first', 'msg-1', 'a.png', '/api/uploads/deadbeef_a.png')`)
	mustExec(t, db, `INSERT INTO attachments (id, message_id, filename, file_url)
		VALUES ('att-dupe', 'msg-2', 'a.png', '/api/uploads/deadbeef_a.png')`)
	mustExec(t, db, `INSERT INTO attachments (id, message_id, filename, file_url)
		VALUES ('att-other', 'msg-3', 'b.png', '/api/uploads/cafebabe_b.png')`)
	mustExec(t, db, `INSERT INTO dm_attachments (id, dm_message_id, filename, file_url)
		VALUES ('dm-first', 'dmsg-1', 'c.png', '/api/uploads/f00df00d_c.png')`)
	mustExec(t, db, `INSERT INTO dm_attachments (id, dm_message_id, filename, file_url)
		VALUES ('dm-dupe', 'dmsg-2', 'c.png', '/api/uploads/f00df00d_c.png')`)

	// Precondition — guards against a vacuously-passing test.
	if n := count(t, db, `SELECT COUNT(*) FROM attachments`); n != 3 {
		t.Fatalf("setup: expected 3 attachment rows, got %d", n)
	}
	if n := count(t, db, `SELECT COUNT(*) FROM dm_attachments`); n != 2 {
		t.Fatalf("setup: expected 2 dm_attachment rows, got %d", n)
	}

	if err := db.applyMigrationFile(migration072, readEmbeddedMigration(t, migration072)); err != nil {
		t.Fatalf("apply migration 072: %v", err)
	}

	// Exactly one row survives per file_url...
	if n := count(t, db,
		`SELECT COUNT(*) FROM attachments WHERE file_url = '/api/uploads/deadbeef_a.png'`); n != 1 {
		t.Fatalf("expected 1 surviving row for the duplicated file_url, got %d", n)
	}
	// ...and it is the EARLIEST one. Keeping the later row would silently
	// re-point the download URL at a different message (different ACL).
	var survivorID string
	if err := db.Conn.QueryRow(
		`SELECT id FROM attachments WHERE file_url = '/api/uploads/deadbeef_a.png'`,
	).Scan(&survivorID); err != nil {
		t.Fatalf("query survivor: %v", err)
	}
	if survivorID != "att-first" {
		t.Errorf("survivor = %q, want %q (earliest rowid must win)", survivorID, "att-first")
	}
	// Non-duplicated rows are untouched.
	if n := count(t, db, `SELECT COUNT(*) FROM attachments WHERE id = 'att-other'`); n != 1 {
		t.Error("072 deleted a row that had no duplicate")
	}
	if n := count(t, db, `SELECT COUNT(*) FROM dm_attachments`); n != 1 {
		t.Errorf("expected 1 surviving dm_attachment row, got %d", n)
	}

	// The constraint is live: a fresh duplicate must be rejected.
	assertDuplicateRejected(t, db,
		`INSERT INTO attachments (id, message_id, filename, file_url)
			VALUES ('att-new', 'msg-9', 'a.png', '/api/uploads/deadbeef_a.png')`)
	assertDuplicateRejected(t, db,
		`INSERT INTO dm_attachments (id, dm_message_id, filename, file_url)
			VALUES ('dm-new', 'dmsg-9', 'c.png', '/api/uploads/f00df00d_c.png')`)

	// A *distinct* file_url still inserts fine — the index constrains
	// duplicates, not writes in general.
	mustExec(t, db, `INSERT INTO attachments (id, message_id, filename, file_url)
		VALUES ('att-ok', 'msg-10', 'd.png', '/api/uploads/12345678_d.png')`)
}

// assertDuplicateRejected requires the insert to fail with a UNIQUE violation
// specifically — not merely "some error", which a typo in the SQL would also
// produce.
func assertDuplicateRejected(t *testing.T, db *DB, insert string) {
	t.Helper()
	_, err := db.Conn.Exec(insert)
	if err == nil {
		t.Fatalf("duplicate file_url insert succeeded; UNIQUE index not enforced:\n%s", insert)
	}
	if !strings.Contains(strings.ToUpper(err.Error()), "UNIQUE") {
		t.Fatalf("expected a UNIQUE constraint error, got: %v", err)
	}
}

// TestMigration072_ReplacesNonUniqueIndexes checks the 071 indexes are gone
// and the unique ones exist, so we don't leave two indexes over one column.
func TestMigration072_ReplacesNonUniqueIndexes(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	seedPre072Attachments(t, db)

	if n := count(t, db,
		`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_attachments_file_url'`); n != 1 {
		t.Fatalf("setup: expected the 071 non-unique index to exist, found %d", n)
	}

	if err := db.applyMigrationFile(migration072, readEmbeddedMigration(t, migration072)); err != nil {
		t.Fatalf("apply migration 072: %v", err)
	}

	for _, gone := range []string{"idx_attachments_file_url", "idx_dm_attachments_file_url"} {
		if n := count(t, db,
			`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, gone); n != 0 {
			t.Errorf("redundant non-unique index %s survived 072", gone)
		}
	}
	for _, want := range []string{"idx_attachments_file_url_unique", "idx_dm_attachments_file_url_unique"} {
		if n := count(t, db,
			`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, want); n != 1 {
			t.Errorf("expected unique index %s after 072, found %d", want, n)
		}
	}
}

// TestMigration072_NoDuplicatesIsANoOp: on a healthy database (the common
// case) the migration must not delete anything.
func TestMigration072_NoDuplicatesIsANoOp(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	seedPre072Attachments(t, db)

	mustExec(t, db, `INSERT INTO attachments (id, message_id, filename, file_url)
		VALUES ('a1', 'm1', 'x.png', '/api/uploads/aaaaaaaa_x.png')`)
	mustExec(t, db, `INSERT INTO attachments (id, message_id, filename, file_url)
		VALUES ('a2', 'm2', 'y.png', '/api/uploads/bbbbbbbb_y.png')`)

	if err := db.applyMigrationFile(migration072, readEmbeddedMigration(t, migration072)); err != nil {
		t.Fatalf("apply migration 072: %v", err)
	}

	if n := count(t, db, `SELECT COUNT(*) FROM attachments`); n != 2 {
		t.Fatalf("072 must be a no-op without duplicates; %d of 2 rows remain", n)
	}
}

// TestMigration072_AppliesOnFullSchema runs the whole embedded migration set
// end-to-end. This is what catches ordering problems the isolated tests above
// cannot: 072 running against the real post-071 schema on a fresh install.
func TestMigration072_AppliesOnFullSchema(t *testing.T) {
	db := newRunnerTestDB(t)
	migrationsFS, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	if err := db.runMigrations(migrationsFS); err != nil {
		t.Fatalf("full migration run: %v", err)
	}
	if n := count(t, db,
		`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_attachments_file_url_unique'`); n != 1 {
		t.Fatalf("unique index missing after a full migration run, found %d", n)
	}
	if n := count(t, db,
		`SELECT COUNT(*) FROM schema_migrations WHERE filename=?`, migration072); n != 1 {
		t.Fatalf("072 not recorded as applied, found %d", n)
	}
}
