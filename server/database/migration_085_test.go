// Migration 085 (user profile columns) tests. Same shape as
// migration_083_084_test.go: the file is applied in isolation on top of a
// minimal users table, then re-run raw to prove the runner's
// "duplicate column name" tolerance makes it idempotent.
package database

import "testing"

const migration085 = "085_user_profile.sql"

var migration085Columns = []string{
	"avatar_animated_url", "banner_url", "bio", "pronouns", "accent_color",
}

func seedPre085Users(t *testing.T, db *DB) {
	t.Helper()
	mustExec(t, db, `CREATE TABLE users (
		id TEXT PRIMARY KEY,
		username TEXT NOT NULL,
		avatar_url TEXT,
		wallpaper_url TEXT
	)`)
}

func userColumnExists(t *testing.T, db *DB, name string) bool {
	t.Helper()
	return count(t, db, `SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = ?`, name) == 1
}

func TestMigration085_AddsColumnsAndIndexes(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	seedPre085Users(t, db)

	content := readEmbeddedMigration(t, migration085)
	if err := db.applyMigrationFile(migration085, content); err != nil {
		t.Fatalf("apply migration 085: %v", err)
	}

	for _, col := range migration085Columns {
		if !userColumnExists(t, db, col) {
			t.Errorf("users.%s missing after migration 085", col)
		}
	}
	for _, idx := range []string{"idx_users_avatar_animated_url", "idx_users_banner_url"} {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); n != 1 {
			t.Errorf("%s index not found after migration 085", idx)
		}
	}

	// New columns default to NULL on existing rows.
	mustExec(t, db, `INSERT INTO users (id, username) VALUES ('u1', 'alice')`)
	if n := count(t, db, `SELECT COUNT(*) FROM users WHERE id = 'u1'
		AND avatar_animated_url IS NULL AND banner_url IS NULL AND bio IS NULL
		AND pronouns IS NULL AND accent_color IS NULL`); n != 1 {
		t.Fatal("new profile columns are not NULL by default")
	}
}

func TestMigration085_SecondRunIsIdempotent(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	seedPre085Users(t, db)

	content := readEmbeddedMigration(t, migration085)
	if err := db.applyMigrationFile(migration085, content); err != nil {
		t.Fatalf("apply migration 085 (first run): %v", err)
	}
	if err := execRawStatements(t, db, migration085, content); err != nil {
		t.Fatalf("re-apply migration 085 statements (second run): %v", err)
	}
	for _, col := range migration085Columns {
		if n := count(t, db, `SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = ?`, col); n != 1 {
			t.Errorf("users.%s count after two runs = %d, want 1", col, n)
		}
	}
}
