// Migration 081 (dm_reads) + 082 (notifications) tests. Mirrors
// migration_080_test.go's shape: each file applied in isolation (both are
// FK-declaring but FK enforcement is off in newRunnerTestDB, so no fixture
// tables are needed), a second raw run to prove idempotency, the 082 CHECK
// constraint, and a full-schema run for ordering.
package database

import (
	"io/fs"
	"testing"
)

const (
	migration081 = "081_dm_reads.sql"
	migration082 = "082_notifications.sql"
)

func TestMigration081_CreatesTableAndIndex(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration081)
	if err := db.applyMigrationFile(migration081, content); err != nil {
		t.Fatalf("apply migration 081: %v", err)
	}

	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='dm_reads'`); n != 1 {
		t.Fatalf("dm_reads table not found after migration 081")
	}
	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_dm_reads_channel'`); n != 1 {
		t.Fatalf("idx_dm_reads_channel index not found after migration 081")
	}

	// Composite PK: a second row for the same (user, channel) must be rejected.
	mustExec(t, db, `INSERT INTO dm_reads (user_id, dm_channel_id) VALUES ('u1', 'dm1')`)
	if _, err := db.Conn.Exec(`INSERT INTO dm_reads (user_id, dm_channel_id) VALUES ('u1', 'dm1')`); err == nil {
		t.Fatal("duplicate (user_id, dm_channel_id) row was accepted, want PRIMARY KEY violation")
	}
	if n := count(t, db, `SELECT unread_count FROM dm_reads WHERE user_id = 'u1' AND dm_channel_id = 'dm1'`); n != 0 {
		t.Fatalf("unread_count default = %d, want 0", n)
	}
}

func TestMigration081_SecondRunIsIdempotent(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration081)
	if err := db.applyMigrationFile(migration081, content); err != nil {
		t.Fatalf("apply migration 081 (first run): %v", err)
	}
	if err := execRawStatements(t, db, migration081, content); err != nil {
		t.Fatalf("re-apply migration 081 statements (second run): %v", err)
	}
	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='dm_reads'`); n != 1 {
		t.Fatalf("dm_reads table count after two runs = %d, want 1", n)
	}
}

func TestMigration082_CreatesTableAndIndexes(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration082)
	if err := db.applyMigrationFile(migration082, content); err != nil {
		t.Fatalf("apply migration 082: %v", err)
	}

	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notifications'`); n != 1 {
		t.Fatalf("notifications table not found after migration 082")
	}
	for _, idx := range []string{
		"idx_notifications_user_created",
		"idx_notifications_user_read",
		"idx_notifications_message",
		"idx_notifications_server",
	} {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); n != 1 {
			t.Errorf("%s index not found after migration 082", idx)
		}
	}
}

// TestMigration082_KindCheckConstraint: the CHECK on kind is the only
// schema-level guard against a typo'd kind string reaching the inbox, so
// prove it rejects an unknown value and accepts every declared one.
func TestMigration082_KindCheckConstraint(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration082)
	if err := db.applyMigrationFile(migration082, content); err != nil {
		t.Fatalf("apply migration 082: %v", err)
	}

	for i, kind := range []string{"mention", "reply", "friend_request", "dm_request", "system"} {
		mustExec(t, db, `INSERT INTO notifications (id, user_id, kind) VALUES (?, 'u1', ?)`, "n"+string(rune('a'+i)), kind)
	}
	if _, err := db.Conn.Exec(`INSERT INTO notifications (id, user_id, kind) VALUES ('bad', 'u1', 'bogus')`); err == nil {
		t.Fatal("INSERT with kind='bogus' was accepted, want CHECK constraint failure")
	}
	if n := count(t, db, `SELECT COUNT(*) FROM notifications`); n != 5 {
		t.Fatalf("notifications rows = %d, want 5", n)
	}
	// Defaults: payload '{}', read_at NULL, created_at populated as text.
	if n := count(t, db, `SELECT COUNT(*) FROM notifications WHERE payload = '{}' AND read_at IS NULL AND length(created_at) = 19`); n != 5 {
		t.Fatalf("rows with default payload/read_at/created_at = %d, want 5", n)
	}
}

func TestMigration082_SecondRunIsIdempotent(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)

	content := readEmbeddedMigration(t, migration082)
	if err := db.applyMigrationFile(migration082, content); err != nil {
		t.Fatalf("apply migration 082 (first run): %v", err)
	}
	if err := execRawStatements(t, db, migration082, content); err != nil {
		t.Fatalf("re-apply migration 082 statements (second run): %v", err)
	}
	if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notifications'`); n != 1 {
		t.Fatalf("notifications table count after two runs = %d, want 1", n)
	}
}

// TestMigration081_082_ApplyOnFullSchema runs the whole embedded migration
// set end-to-end — the ordering check the isolated tests above cannot cover.
func TestMigration081_082_ApplyOnFullSchema(t *testing.T) {
	db := newRunnerTestDB(t)
	migrationsFS, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	if err := db.runMigrations(migrationsFS); err != nil {
		t.Fatalf("full migration run: %v", err)
	}

	for _, table := range []string{"dm_reads", "notifications"} {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, table); n != 1 {
			t.Errorf("%s table not found after a full migration run", table)
		}
	}
	for _, file := range []string{migration081, migration082} {
		if n := count(t, db, `SELECT COUNT(*) FROM schema_migrations WHERE filename=?`, file); n != 1 {
			t.Errorf("%s not recorded as applied, found %d", file, n)
		}
	}
}
