package database

import "testing"

func TestMigration140BackfillsLegacyGroupOrderAndKeepsClearedReads(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	statements := []string{
		`CREATE TABLE group_dm_channels(id TEXT PRIMARY KEY)`,
		`CREATE TABLE group_dm_messages(id TEXT PRIMARY KEY,group_id TEXT,created_at TEXT)`,
		`CREATE TABLE group_dm_reads(group_id TEXT,user_id TEXT,last_read_message_id TEXT,unread_count INTEGER)`,
		`INSERT INTO group_dm_channels(id) VALUES('g')`,
		`INSERT INTO group_dm_messages(id,group_id,created_at) VALUES('z','g','2026-01-01 00:00:00'),('a','g','2026-01-01 00:00:00'),('late','g','2026-01-01 00:00:01')`,
		`INSERT INTO group_dm_reads VALUES('g','partial','z',1),('g','cleared',NULL,0)`,
	}
	for _, statement := range statements {
		if _, err := db.Conn.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	const name = "140_group_dm_source_sequence.sql"
	if err := db.applyMigrationFile(name, readEmbeddedMigration(t, name)); err != nil {
		t.Fatal(err)
	}
	var sequence int64
	for id, want := range map[string]int64{"a": 1, "z": 2, "late": 3} {
		if err := db.Conn.QueryRow(`SELECT source_sequence FROM group_dm_messages WHERE id=?`, id).Scan(&sequence); err != nil || sequence != want {
			t.Fatalf("legacy source %s=%d want=%d err=%v", id, sequence, want, err)
		}
	}
	for user, want := range map[string]int64{"partial": 2, "cleared": 3} {
		if err := db.Conn.QueryRow(`SELECT last_read_source_sequence FROM group_dm_reads WHERE user_id=?`, user).Scan(&sequence); err != nil || sequence != want {
			t.Fatalf("legacy watermark %s=%d want=%d err=%v", user, sequence, want, err)
		}
	}
	if _, err := db.Conn.Exec(`DELETE FROM group_dm_messages WHERE id='late'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO group_dm_messages(id,group_id,created_at) VALUES('new','g','2025-01-01 00:00:00')`); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT source_sequence FROM group_dm_messages WHERE id='new'`).Scan(&sequence); err != nil || sequence != 4 {
		t.Fatalf("deleted tail reused=%d err=%v", sequence, err)
	}
	if _, err := db.Conn.Exec(`UPDATE group_dm_messages SET source_sequence=99 WHERE id='new'`); err == nil {
		t.Fatal("positive sequence mutated")
	}
}
