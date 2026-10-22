// Migration 088 (entrance sounds) tests. Same shape as migration_087_test.go:
// the file is applied in isolation (FK enforcement is off in newRunnerTestDB,
// so only the roles table the trailing UPDATE touches needs a fixture), then
// re-run raw to prove the IF NOT EXISTS guards and the bitwise-OR UPDATE make
// it idempotent.
package database

import "testing"

const migration088 = "088_entrance_sounds.sql"

const permUseEntranceSound088 = 2097152 // models.PermUseEntranceSound (1 << 21)

var migration088Tables = []string{
	"user_entrance_sounds",
	"user_entrance_selection",
	"server_entrance_settings",
	"channel_entrance_disabled",
	"server_entrance_mutes",
}

var migration088Indexes = []string{
	"idx_user_entrance_sounds_user",
	"idx_user_entrance_sounds_file_url",
	"idx_user_entrance_selection_sound",
	"idx_user_entrance_selection_scope",
	"idx_channel_entrance_disabled_server",
	"idx_server_entrance_mutes_user",
}

// seedRoles088 creates the 001 roles shape with one default and one
// non-default role. The default role already holds a few bits so the test can
// prove the UPDATE ORs instead of overwriting.
func seedRoles088(t *testing.T, db *DB) {
	t.Helper()
	mustExec(t, db, `CREATE TABLE roles (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		permissions INTEGER NOT NULL DEFAULT 0,
		is_default INTEGER NOT NULL DEFAULT 0
	)`)
	mustExec(t, db, `INSERT INTO roles (id, name, permissions, is_default) VALUES ('r-default', 'everyone', 6368, 1)`)
	mustExec(t, db, `INSERT INTO roles (id, name, permissions, is_default) VALUES ('r-mod', 'mod', 16384, 0)`)
}

func rolePerms088(t *testing.T, db *DB, id string) int64 {
	t.Helper()
	var p int64
	if err := db.Conn.QueryRow(`SELECT permissions FROM roles WHERE id = ?`, id).Scan(&p); err != nil {
		t.Fatalf("read role %s permissions: %v", id, err)
	}
	return p
}

func TestMigration088_CreatesTablesIndexesAndGrantsDefaultRoleBit(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	seedRoles088(t, db)

	content := readEmbeddedMigration(t, migration088)
	if err := db.applyMigrationFile(migration088, content); err != nil {
		t.Fatalf("apply migration 088: %v", err)
	}

	for _, tbl := range migration088Tables {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, tbl); n != 1 {
			t.Errorf("%s table not found after migration 088", tbl)
		}
	}
	for _, idx := range migration088Indexes {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); n != 1 {
			t.Errorf("%s index not found after migration 088", idx)
		}
	}

	if got := rolePerms088(t, db, "r-default"); got != 6368|permUseEntranceSound088 {
		t.Errorf("default role permissions = %d, want %d (existing bits kept + bit 21)", got, 6368|permUseEntranceSound088)
	}
	if got := rolePerms088(t, db, "r-mod"); got != 16384 {
		t.Errorf("non-default role permissions = %d, want 16384 (untouched)", got)
	}

	// Defaults on server_entrance_settings: enabled 1, max 5000, text timestamp.
	mustExec(t, db, `INSERT INTO server_entrance_settings (server_id) VALUES ('srv1')`)
	if n := count(t, db, `SELECT COUNT(*) FROM server_entrance_settings WHERE server_id = 'srv1'
		AND enabled = 1 AND max_duration_ms = 5000 AND updated_at LIKE '____-__-__ __:__:__'`); n != 1 {
		t.Error("server_entrance_settings defaults not applied")
	}

	// Selection CHECK: clip rows carry sound_id only, preset rows preset only.
	mustExec(t, db, `INSERT INTO user_entrance_sounds (id, user_id, name, file_url, duration_ms, size)
		VALUES ('0123456789abcdef', 'u1', 'Davul', '/api/uploads/entrance/0123456789abcdef.wav', 1000, 48044)`)
	if _, err := db.Conn.Exec(`INSERT INTO user_entrance_selection (user_id, scope_server_id, kind, sound_id, preset)
		VALUES ('u1', '', 'clip', '0123456789abcdef', '{"v":1}')`); err == nil {
		t.Error("clip selection with a preset accepted, want CHECK failure")
	}
	if _, err := db.Conn.Exec(`INSERT INTO user_entrance_selection (user_id, scope_server_id, kind, sound_id, preset)
		VALUES ('u1', '', 'preset', NULL, NULL)`); err == nil {
		t.Error("preset selection without a preset accepted, want CHECK failure")
	}
	if _, err := db.Conn.Exec(`INSERT INTO user_entrance_selection (user_id, scope_server_id, kind, sound_id, preset)
		VALUES ('u1', '', 'loud', NULL, '{"v":1}')`); err == nil {
		t.Error("unknown kind accepted, want CHECK failure")
	}
	mustExec(t, db, `INSERT INTO user_entrance_selection (user_id, scope_server_id, kind, sound_id)
		VALUES ('u1', '', 'clip', '0123456789abcdef')`)
	// PK (user_id, scope_server_id): a second global row for u1 is rejected.
	if _, err := db.Conn.Exec(`INSERT INTO user_entrance_selection (user_id, scope_server_id, kind, preset)
		VALUES ('u1', '', 'preset', '{"v":1}')`); err == nil {
		t.Error("duplicate (user_id, scope_server_id) accepted, want PK failure")
	}
	// UNIQUE file_url.
	if _, err := db.Conn.Exec(`INSERT INTO user_entrance_sounds (id, user_id, name, file_url, duration_ms, size)
		VALUES ('fedcba9876543210', 'u2', 'X', '/api/uploads/entrance/0123456789abcdef.wav', 1000, 48044)`); err == nil {
		t.Error("duplicate file_url accepted, want UNIQUE failure")
	}
}

func TestMigration088_SecondRunIsIdempotent(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	seedRoles088(t, db)

	content := readEmbeddedMigration(t, migration088)
	if err := db.applyMigrationFile(migration088, content); err != nil {
		t.Fatalf("apply migration 088 (first run): %v", err)
	}
	afterFirst := rolePerms088(t, db, "r-default")
	if err := execRawStatements(t, db, migration088, content); err != nil {
		t.Fatalf("re-apply migration 088 statements (second run): %v", err)
	}
	if got := rolePerms088(t, db, "r-default"); got != afterFirst {
		t.Errorf("default role permissions changed on second run: %d -> %d", afterFirst, got)
	}
	for _, tbl := range migration088Tables {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, tbl); n != 1 {
			t.Errorf("%s table count after two runs = %d, want 1", tbl, n)
		}
	}
	for _, idx := range migration088Indexes {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); n != 1 {
			t.Errorf("%s count after two runs = %d, want 1", idx, n)
		}
	}
}
