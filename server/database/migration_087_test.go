// Migration 087 (server_stickers) tests. Same shape as migration_086_test.go:
// the file is applied in isolation (FK enforcement is off in
// newRunnerTestDB, so no servers/users fixture tables are needed), then
// re-run raw to prove the IF NOT EXISTS guards make it idempotent.
package database

import "testing"

const migration087 = "087_server_stickers.sql"

var migration087Indexes = []string{
	"idx_server_stickers_server",
	"idx_server_stickers_file_url",
	"idx_server_stickers_animated_url",
	"idx_server_stickers_created_by",
}

func TestMigration087_CreatesTableAndIndexes(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration087)
	if err := db.applyMigrationFile(migration087, content); err != nil {
		t.Fatalf("apply migration 087: %v", err)
	}

	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='server_stickers'`); n != 1 {
		t.Fatal("server_stickers table not found after migration 087")
	}
	for _, idx := range migration087Indexes {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); n != 1 {
			t.Errorf("%s index not found after migration 087", idx)
		}
	}

	// Defaults: description '', tags '[]', animated/copyable 0, nullable
	// columns NULL, created_at as 'YYYY-MM-DD HH:MM:SS' text.
	mustExec(t, db, `INSERT INTO server_stickers (id, server_id, name, display_name, file_url)
		VALUES ('s1', 'srv1', 'kedi', 'Kedi', '/api/uploads/stickers/s1.png')`)
	if n := count(t, db, `SELECT COUNT(*) FROM server_stickers WHERE id = 's1'
		AND description = '' AND tags = '[]' AND animated = 0 AND copyable = 0
		AND animated_url IS NULL AND cloned_from IS NULL AND created_by IS NULL
		AND created_at LIKE '____-__-__ __:__:__'`); n != 1 {
		t.Fatal("defaults not applied on the 087 row")
	}

	// UNIQUE (server_id, name): same name in another server is fine.
	if _, err := db.Conn.Exec(`INSERT INTO server_stickers (id, server_id, name, display_name, file_url)
		VALUES ('s2', 'srv1', 'kedi', 'Kedi 2', '/api/uploads/stickers/s2.png')`); err == nil {
		t.Error("duplicate (server_id, name) accepted, want UNIQUE failure")
	}
	mustExec(t, db, `INSERT INTO server_stickers (id, server_id, name, display_name, file_url)
		VALUES ('s3', 'srv2', 'kedi', 'Kedi', '/api/uploads/stickers/s3.png')`)
	// UNIQUE file_url.
	if _, err := db.Conn.Exec(`INSERT INTO server_stickers (id, server_id, name, display_name, file_url)
		VALUES ('s4', 'srv2', 'kopek', 'Kopek', '/api/uploads/stickers/s1.png')`); err == nil {
		t.Error("duplicate file_url accepted, want UNIQUE failure")
	}
}

func TestMigration087_SecondRunIsIdempotent(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration087)
	if err := db.applyMigrationFile(migration087, content); err != nil {
		t.Fatalf("apply migration 087 (first run): %v", err)
	}
	if err := execRawStatements(t, db, migration087, content); err != nil {
		t.Fatalf("re-apply migration 087 statements (second run): %v", err)
	}
	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='server_stickers'`); n != 1 {
		t.Errorf("server_stickers table count after two runs = %d, want 1", n)
	}
	for _, idx := range migration087Indexes {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); n != 1 {
			t.Errorf("%s count after two runs = %d, want 1", idx, n)
		}
	}
}
