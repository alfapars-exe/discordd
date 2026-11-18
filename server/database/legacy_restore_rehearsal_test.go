package database

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// Rehearse recovery from an unknown edited schema using a consistent file
// snapshot, not an in-place repair or a forged migration ledger.
func TestLegacyRecoveryFromVerifiedBackup(t *testing.T) {
	migrations, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	entries, err := fs.ReadDir(migrations, ".")
	if err != nil {
		t.Fatal(err)
	}
	prefix := fstest.MapFS{}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".sql") || name > "144_thread_channel_type.sql" {
			continue
		}
		data, err := fs.ReadFile(migrations, name)
		if err != nil {
			t.Fatal(err)
		}
		prefix[name] = &fstest.MapFile{Data: data}
	}
	original := newRunnerTestDB(t)
	if err := original.runMigrations(prefix); err != nil {
		t.Fatal(err)
	}
	mustExec(t, original, "INSERT INTO users(id,username,password_hash) VALUES('restore-user','restore-owner','fixture-hash')")
	mustExec(t, original, "INSERT INTO servers(id,name,owner_id) VALUES('restore-server','restore-server','restore-user')")
	mustExec(t, original, "INSERT INTO channels(id,name,type,server_id) VALUES('restore-channel','general','text','restore-server')")
	mustExec(t, original, "INSERT INTO messages(id,channel_id,user_id,content) VALUES('restore-message','restore-channel','restore-user','preserved history')")
	mustExec(t, original, "DELETE FROM schema_migrations")
	backup := filepath.Join(t.TempDir(), "verified-backup.sqlite")
	mustExec(t, original, "VACUUM INTO ?", backup)
	mustExec(t, original, "CREATE INDEX unknown_recovery_index ON users(username)")
	if err := original.runMigrations(migrations); err == nil || !strings.Contains(err.Error(), "unrecognized SQLite schema") {
		t.Fatalf("unknown edited schema accepted: %v", err)
	}
	if n := count(t, original, "SELECT count(*) FROM schema_migrations"); n != 0 {
		t.Fatalf("failed adoption forged %d ledger rows", n)
	}
	if err := original.Close(); err != nil {
		t.Fatal(err)
	}
	snapshot, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	restoredPath := filepath.Join(t.TempDir(), "restored.sqlite")
	if err := os.WriteFile(restoredPath, snapshot, 0600); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		restored, err := NewLegacy(restoredPath, migrations)
		if err != nil {
			t.Fatalf("restore/reopen %d: %v", attempt, err)
		}
		func() {
			defer func() {
				if err := restored.Close(); err != nil {
					t.Error(err)
				}
			}()
			if n := count(t, restored, "SELECT count(*) FROM users WHERE id='restore-user' AND username='restore-owner'"); n != 1 {
				t.Fatalf("restored users: %d", n)
			}
			if n := count(t, restored, "SELECT count(*) FROM messages m JOIN channels c ON c.id=m.channel_id JOIN servers s ON s.id=c.server_id WHERE m.id='restore-message' AND m.content='preserved history' AND s.owner_id=m.user_id"); n != 1 {
				t.Fatalf("restored message graph: %d", n)
			}
			if n := count(t, restored, "SELECT count(*) FROM schema_migrations WHERE filename='150_dm_attachment_order.sql'"); n != 1 {
				t.Fatalf("upgraded migration ledger: %d", n)
			}
			if n := count(t, restored, "SELECT count(*) FROM sqlite_master WHERE name='unknown_recovery_index'"); n != 0 {
				t.Fatal("restored the edited database instead of verified backup")
			}
			var integrity string
			if err := restored.Conn.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
				t.Fatalf("restored integrity: %q, %v", integrity, err)
			}
			rows, err := restored.Conn.Query("PRAGMA foreign_key_check")
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			if rows.Next() {
				t.Fatal("restored graph has foreign key violations")
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
		}()
	}
}
