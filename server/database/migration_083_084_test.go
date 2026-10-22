// Migration 083 (saved_messages) + 084 (user_notes) tests. Same shape as
// migration_081_082_test.go: each file applied in isolation (FK enforcement is
// off in newRunnerTestDB, so no fixture tables are needed), a second raw run
// to prove idempotency, the 083 CHECK / UNIQUE constraints, the 084 primary
// key, and a full-schema run for ordering.
package database

import (
	"io/fs"
	"testing"
)

const (
	migration083 = "083_saved_messages.sql"
	migration084 = "084_user_notes.sql"
)

func TestMigration083_CreatesTableAndIndexes(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration083)
	if err := db.applyMigrationFile(migration083, content); err != nil {
		t.Fatalf("apply migration 083: %v", err)
	}

	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='saved_messages'`); n != 1 {
		t.Fatalf("saved_messages table not found after migration 083")
	}
	for _, idx := range []string{
		"idx_saved_messages_user_created",
		"idx_saved_messages_message",
		"idx_saved_messages_dm_message",
	} {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); n != 1 {
			t.Errorf("%s index not found after migration 083", idx)
		}
	}

	// Defaults: note NULL, created_at populated as 19-char text.
	mustExec(t, db, `INSERT INTO saved_messages (id, user_id, message_id) VALUES ('s1', 'u1', 'm1')`)
	if n := count(t, db, `SELECT COUNT(*) FROM saved_messages WHERE id = 's1' AND note IS NULL AND length(created_at) = 19`); n != 1 {
		t.Fatalf("default note/created_at not applied on the 083 row")
	}
}

// TestMigration083_CheckConstraint — exactly one of message_id /
// dm_message_id must be set: both and neither are rejected.
func TestMigration083_CheckConstraint(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration083)
	if err := db.applyMigrationFile(migration083, content); err != nil {
		t.Fatalf("apply migration 083: %v", err)
	}

	mustExec(t, db, `INSERT INTO saved_messages (id, user_id, message_id) VALUES ('ok-msg', 'u1', 'm1')`)
	mustExec(t, db, `INSERT INTO saved_messages (id, user_id, dm_message_id) VALUES ('ok-dm', 'u1', 'd1')`)

	if _, err := db.Conn.Exec(`INSERT INTO saved_messages (id, user_id, message_id, dm_message_id) VALUES ('both', 'u1', 'm2', 'd2')`); err == nil {
		t.Fatal("row with BOTH message_id and dm_message_id was accepted, want CHECK failure")
	}
	if _, err := db.Conn.Exec(`INSERT INTO saved_messages (id, user_id) VALUES ('neither', 'u1')`); err == nil {
		t.Fatal("row with NEITHER message_id nor dm_message_id was accepted, want CHECK failure")
	}
	if n := count(t, db, `SELECT COUNT(*) FROM saved_messages`); n != 2 {
		t.Fatalf("saved_messages rows = %d, want 2", n)
	}
}

// TestMigration083_UniquePerUserAndMessage — the same user cannot bookmark
// the same message twice, while another user still can.
func TestMigration083_UniquePerUserAndMessage(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration083)
	if err := db.applyMigrationFile(migration083, content); err != nil {
		t.Fatalf("apply migration 083: %v", err)
	}

	mustExec(t, db, `INSERT INTO saved_messages (id, user_id, message_id) VALUES ('s1', 'u1', 'm1')`)
	if _, err := db.Conn.Exec(`INSERT INTO saved_messages (id, user_id, message_id) VALUES ('s2', 'u1', 'm1')`); err == nil {
		t.Fatal("duplicate (user_id, message_id) row was accepted, want UNIQUE violation")
	}
	mustExec(t, db, `INSERT INTO saved_messages (id, user_id, message_id) VALUES ('s3', 'u2', 'm1')`)

	mustExec(t, db, `INSERT INTO saved_messages (id, user_id, dm_message_id) VALUES ('d1', 'u1', 'dm1')`)
	if _, err := db.Conn.Exec(`INSERT INTO saved_messages (id, user_id, dm_message_id) VALUES ('d2', 'u1', 'dm1')`); err == nil {
		t.Fatal("duplicate (user_id, dm_message_id) row was accepted, want UNIQUE violation")
	}
}

func TestMigration083_SecondRunIsIdempotent(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration083)
	if err := db.applyMigrationFile(migration083, content); err != nil {
		t.Fatalf("apply migration 083 (first run): %v", err)
	}
	if err := execRawStatements(t, db, migration083, content); err != nil {
		t.Fatalf("re-apply migration 083 statements (second run): %v", err)
	}
	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='saved_messages'`); n != 1 {
		t.Fatalf("saved_messages table count after two runs = %d, want 1", n)
	}
}

func TestMigration084_CreatesTableWithCompositePK(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration084)
	if err := db.applyMigrationFile(migration084, content); err != nil {
		t.Fatalf("apply migration 084: %v", err)
	}

	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='user_notes'`); n != 1 {
		t.Fatalf("user_notes table not found after migration 084")
	}

	mustExec(t, db, `INSERT INTO user_notes (owner_user_id, target_user_id, note) VALUES ('u1', 'u2', 'met at the meetup')`)
	if _, err := db.Conn.Exec(`INSERT INTO user_notes (owner_user_id, target_user_id, note) VALUES ('u1', 'u2', 'dup')`); err == nil {
		t.Fatal("duplicate (owner_user_id, target_user_id) row was accepted, want PRIMARY KEY violation")
	}
	// The reverse direction is a different note (u2's private note about u1).
	mustExec(t, db, `INSERT INTO user_notes (owner_user_id, target_user_id, note) VALUES ('u2', 'u1', 'other way')`)
	if n := count(t, db, `SELECT COUNT(*) FROM user_notes WHERE length(updated_at) = 19`); n != 2 {
		t.Fatalf("rows with default updated_at text = %d, want 2", n)
	}
}

func TestMigration084_SecondRunIsIdempotent(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration084)
	if err := db.applyMigrationFile(migration084, content); err != nil {
		t.Fatalf("apply migration 084 (first run): %v", err)
	}
	if err := execRawStatements(t, db, migration084, content); err != nil {
		t.Fatalf("re-apply migration 084 statements (second run): %v", err)
	}
	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='user_notes'`); n != 1 {
		t.Fatalf("user_notes table count after two runs = %d, want 1", n)
	}
}

// TestMigration083_084_ApplyOnFullSchema runs the whole embedded migration
// set end-to-end — the ordering check the isolated tests above cannot cover.
func TestMigration083_084_ApplyOnFullSchema(t *testing.T) {
	db := newRunnerTestDB(t)
	migrationsFS, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	if err := db.runMigrations(migrationsFS); err != nil {
		t.Fatalf("full migration run: %v", err)
	}

	for _, table := range []string{"saved_messages", "user_notes"} {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, table); n != 1 {
			t.Errorf("%s table not found after a full migration run", table)
		}
	}
	for _, file := range []string{migration083, migration084} {
		if n := count(t, db, `SELECT COUNT(*) FROM schema_migrations WHERE filename=?`, file); n != 1 {
			t.Errorf("%s not recorded as applied, found %d", file, n)
		}
	}
}
