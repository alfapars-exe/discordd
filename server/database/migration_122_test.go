package database

import (
	"strings"
	"testing"
	"testing/fstest"
)

func TestMigration122PreservesExistingMediaLabelsAndRunnerReplay(t *testing.T) {
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	if _, err := db.Conn.Exec(`CREATE TABLE users(id TEXT PRIMARY KEY,deleted_at INTEGER); INSERT INTO users(id) VALUES('owner');`); err != nil {
		t.Fatal(err)
	}
	if err := db.applyMigrationFile("121_private_media_labels.sql", readEmbeddedMigration(t, "121_private_media_labels.sql")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO private_media_labels(user_id,source_kind,channel_id,message_id,revision,fingerprint,label) VALUES('owner','dm','private','message','original',?,'sexual')`, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	migration := readEmbeddedMigration(t, "122_private_media_label_versions.sql")
	files := fstest.MapFS{
		"121_private_media_labels.sql":         &fstest.MapFile{Data: []byte(readEmbeddedMigration(t, "121_private_media_labels.sql"))},
		"122_private_media_label_versions.sql": &fstest.MapFile{Data: []byte(migration)},
	}
	if err := db.runMigrations(files); err != nil {
		t.Fatal(err)
	}
	assertState := func(wantVersion string) {
		t.Helper()
		var owner, kind, channel, message, revision, fingerprint, label, version string
		err := db.Conn.QueryRow(`SELECT user_id,source_kind,channel_id,message_id,revision,fingerprint,label,version FROM private_media_labels`).Scan(&owner, &kind, &channel, &message, &revision, &fingerprint, &label, &version)
		if err != nil || owner != "owner" || kind != "dm" || channel != "private" || message != "message" || revision != "original" || fingerprint != strings.Repeat("a", 64) || label != "sexual" || version != wantVersion {
			t.Fatalf("migration lost source or label: %v %s %s %s %s %s %s %s %s", err, owner, kind, channel, message, revision, fingerprint, label, version)
		}
	}
	assertState("legacy")
	if _, err := db.Conn.Exec(`UPDATE private_media_labels SET version=?`, strings.Repeat("b", 32)); err != nil {
		t.Fatal(err)
	}
	if err := db.runMigrations(files); err != nil {
		t.Fatal(err)
	}
	assertState(strings.Repeat("b", 32))
	// A failed/incomplete rollback transaction must not lose the new column or data.
	tx, err := db.Conn.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(`ALTER TABLE private_media_labels DROP COLUMN version`); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	assertState(strings.Repeat("b", 32))
}
