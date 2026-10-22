// Migration 086 (server_emojis) tests. Same shape as migration_085_test.go:
// the file is applied in isolation (FK enforcement is off in
// newRunnerTestDB, so no servers/users fixture tables are needed), then
// re-run raw to prove the IF NOT EXISTS guards make it idempotent.
package database

import "testing"

const migration086 = "086_server_emojis.sql"

var migration086Indexes = []string{
	"idx_server_emojis_server",
	"idx_server_emojis_file_url",
	"idx_server_emojis_animated_url",
	"idx_server_emojis_created_by",
}

func TestMigration086_CreatesTableAndIndexes(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration086)
	if err := db.applyMigrationFile(migration086, content); err != nil {
		t.Fatalf("apply migration 086: %v", err)
	}

	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='server_emojis'`); n != 1 {
		t.Fatal("server_emojis table not found after migration 086")
	}
	for _, idx := range migration086Indexes {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); n != 1 {
			t.Errorf("%s index not found after migration 086", idx)
		}
	}

	// Defaults: animated/copyable 0, nullable columns NULL, created_at as
	// 'YYYY-MM-DD HH:MM:SS' text.
	mustExec(t, db, `INSERT INTO server_emojis (id, server_id, name, display_name, file_url)
		VALUES ('e1', 's1', 'kedi', 'Kedi', '/api/uploads/emojis/e1.png')`)
	if n := count(t, db, `SELECT COUNT(*) FROM server_emojis WHERE id = 'e1'
		AND animated = 0 AND copyable = 0 AND animated_url IS NULL AND cloned_from IS NULL
		AND created_by IS NULL AND created_at LIKE '____-__-__ __:__:__'`); n != 1 {
		t.Fatal("defaults not applied on the 086 row")
	}

	// UNIQUE (server_id, name): same name in another server is fine.
	if _, err := db.Conn.Exec(`INSERT INTO server_emojis (id, server_id, name, display_name, file_url)
		VALUES ('e2', 's1', 'kedi', 'Kedi 2', '/api/uploads/emojis/e2.png')`); err == nil {
		t.Error("duplicate (server_id, name) accepted, want UNIQUE failure")
	}
	mustExec(t, db, `INSERT INTO server_emojis (id, server_id, name, display_name, file_url)
		VALUES ('e3', 's2', 'kedi', 'Kedi', '/api/uploads/emojis/e3.png')`)
	// UNIQUE file_url.
	if _, err := db.Conn.Exec(`INSERT INTO server_emojis (id, server_id, name, display_name, file_url)
		VALUES ('e4', 's2', 'kopek', 'Kopek', '/api/uploads/emojis/e1.png')`); err == nil {
		t.Error("duplicate file_url accepted, want UNIQUE failure")
	}
}

func TestMigration086_SecondRunIsIdempotent(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration086)
	if err := db.applyMigrationFile(migration086, content); err != nil {
		t.Fatalf("apply migration 086 (first run): %v", err)
	}
	if err := execRawStatements(t, db, migration086, content); err != nil {
		t.Fatalf("re-apply migration 086 statements (second run): %v", err)
	}
	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='server_emojis'`); n != 1 {
		t.Errorf("server_emojis table count after two runs = %d, want 1", n)
	}
	for _, idx := range migration086Indexes {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); n != 1 {
			t.Errorf("%s count after two runs = %d, want 1", idx, n)
		}
	}
}
