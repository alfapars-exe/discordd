package database

import (
	"io/fs"
	"testing"
	"testing/fstest"
)

func TestMigration139DMSourceLegacyBackfillAndAppend(t *testing.T) {
	db := newRunnerTestDB(t)
	prior := fstest.MapFS{}
	all := fstest.MapFS{}
	const latest = "139_dm_source_sequence.sql"
	entries, err := fs.ReadDir(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() > latest {
			continue
		}
		raw, err := fs.ReadFile(EmbeddedMigrations, "migrations/"+entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		all[entry.Name()] = &fstest.MapFile{Data: raw}
		if entry.Name() < latest {
			prior[entry.Name()] = &fstest.MapFile{Data: raw}
		}
	}
	if err := db.runMigrations(prior); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`INSERT INTO users(id,username,password_hash) VALUES('seq-a','seqa','opaque-hash'),('seq-b','seqb','opaque-hash')`, `INSERT INTO dm_channels(id,user1_id,user2_id) VALUES('legacy-seq','seq-a','seq-b')`, `INSERT INTO dm_messages(id,dm_channel_id,user_id,content,encryption_version,ciphertext,e2ee_metadata,created_at) VALUES('z-legacy','legacy-seq','seq-a',NULL,1,'opaque-cipher','opaque-metadata','2026-10-25 11:11:44'),('a-legacy','legacy-seq','seq-a','opaque legacy',0,NULL,NULL,'2026-10-25 11:11:44')`, `INSERT INTO dm_reads(user_id,dm_channel_id,last_read_message_id,last_read_at,unread_count) VALUES('seq-b','legacy-seq','z-legacy','2026-10-25 11:11:44',0)`} {
		if _, err := db.Conn.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.runMigrations(all); err != nil {
		t.Fatal(err)
	}
	var source, counter, read int64
	var ciphertext, metadata string
	if err := db.Conn.QueryRow(`SELECT source_sequence,ciphertext,e2ee_metadata FROM dm_messages WHERE id='z-legacy'`).Scan(&source, &ciphertext, &metadata); err != nil || source != 2 || ciphertext != "opaque-cipher" || metadata != "opaque-metadata" {
		t.Fatalf("legacy mapping or ciphertext changed seq=%d %v", source, err)
	}
	if err := db.Conn.QueryRow(`SELECT last_source_sequence FROM dm_channels WHERE id='legacy-seq'`).Scan(&counter); err != nil || counter != 2 {
		t.Fatal("legacy counter incorrect")
	}
	if err := db.Conn.QueryRow(`SELECT last_read_source_sequence FROM dm_reads WHERE dm_channel_id='legacy-seq'`).Scan(&read); err != nil || read != 2 {
		t.Fatal("legacy read mapping incorrect")
	}
	if _, err := db.Conn.Exec(`INSERT INTO dm_messages(id,dm_channel_id,user_id,content,created_at) VALUES('0-new','legacy-seq','seq-a','new','2026-10-25 11:11:44')`); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT source_sequence FROM dm_messages WHERE id='0-new'`).Scan(&source); err != nil || source != 3 {
		t.Fatalf("new append seq=%d %v", source, err)
	}
	if err := db.runMigrations(all); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT last_source_sequence FROM dm_channels WHERE id='legacy-seq'`).Scan(&counter); err != nil || counter != 3 {
		t.Fatal("re-run rewound counter")
	}
}
