package database

import "testing"

func TestMigration093_BackfillsOnlyEligibleLegacySessions(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	// Recreate the relevant pre-092 contract rather than starting on the final schema.
	_, err := db.Conn.Exec(`CREATE TABLE users(id TEXT PRIMARY KEY,token_version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,refresh_token TEXT,created_at TEXT,expires_at TEXT);
INSERT INTO users VALUES('owner',3),('other',0);
INSERT INTO sessions VALUES
('active','owner','a','2026-01-01 00:00:00',datetime('now','+1 day')),
('expired','owner','b','2026-01-01 00:00:00',datetime('now','-1 day')),
('stale','owner','c','2026-01-01 00:00:00',datetime('now','+1 day')),
('foreign','other','d','2026-01-01 00:00:00',datetime('now','+1 day'));`)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.applyMigrationFile("092_auth_sessions.sql", readEmbeddedMigration(t, "092_auth_sessions.sql")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE sessions SET token_version=2 WHERE id='stale'`); err != nil {
		t.Fatal(err)
	}
	content := readEmbeddedMigration(t, "093_backfill_auth_sessions.sql")
	if err := db.applyMigrationFile("093_backfill_auth_sessions.sql", content); err != nil {
		t.Fatal(err)
	}
	if n := count(t, db, `SELECT count(*) FROM auth_sessions`); n != 2 {
		t.Fatalf("backfilled %d, want 2", n)
	}
	if n := count(t, db, `SELECT count(*) FROM sessions WHERE auth_session_id IS NOT NULL`); n != 2 {
		t.Fatalf("bound %d, want 2", n)
	}
	if n := count(t, db, `SELECT count(*) FROM auth_sessions WHERE id='active' AND user_id='owner' AND token_version=3 AND client_type='unknown' AND user_agent='' AND created_at>0 AND expires_at>created_at`); n != 1 {
		t.Fatal("legacy identity/times/version/metadata were not preserved")
	}
	// Even raw backfill re-execution cannot revive a tombstoned sign-in.
	if _, err := db.Conn.Exec(`UPDATE auth_sessions SET revoked_at=1 WHERE id='active'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(string(content)); err != nil {
		t.Fatal(err)
	}
	if n := count(t, db, `SELECT count(*) FROM auth_sessions WHERE id='active' AND revoked_at=1`); n != 1 {
		t.Fatal("backfill revived a revoked session")
	}
}
