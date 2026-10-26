package database

import (
	"database/sql"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestMigration144AllowsLegacyOrphansButRejectsNewViolations(t *testing.T) {
	raw, err := fs.ReadFile(EmbeddedMigrations, "migrations/144_thread_channel_type.sql")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, newViolation := range []bool{false, true} {
		name := "preserve_legacy_orphans"
		if newViolation {
			name = "rollback_new_violation"
		}
		t.Run(name, func(t *testing.T) {
			conn, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "legacy.db"))
			if err != nil {
				t.Fatal(err)
			}
			conn.SetMaxOpenConns(1)
			db := &DB{Conn: conn}
			defer db.Close()
			// Match an old libSQL installation: FK enforcement disabled, including
			// an orphan on channels itself whose sparse rowid must survive rebuild.
			oldDDL := strings.Split(content, "INSERT INTO channels_thread_type_upgrade")[0]
			oldDDL = strings.ReplaceAll(oldDDL, "channels_thread_type_upgrade", "channels")
			oldDDL = strings.ReplaceAll(oldDDL, "'audit', 'thread'", "'audit'")
			for _, query := range []string{
				`PRAGMA foreign_keys=OFF`,
				`CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY)`,
				`CREATE TABLE categories(id TEXT PRIMARY KEY)`,
				`CREATE TABLE messages(id TEXT PRIMARY KEY)`,
				`CREATE TABLE users(id TEXT PRIMARY KEY)`,
				`CREATE TABLE legacy_orphans(id INTEGER PRIMARY KEY, user_id TEXT REFERENCES users(id))`,
				oldDDL,
				`INSERT INTO channels(rowid,id,name,type,category_id) VALUES(42,'orphan','legacy','text','missing-category')`,
				`INSERT INTO channels(rowid,id,name,type) VALUES(100,'healthy','healthy','text')`,
				`INSERT INTO legacy_orphans(id,user_id) VALUES(7,'missing-user')`,
			} {
				if _, err := conn.Exec(query); err != nil {
					t.Fatalf("seed: %v", err)
				}
			}
			migration := content
			if newViolation {
				migration += "\nUPDATE channels SET category_id='another-missing-category' WHERE id='healthy';"
			}
			err = db.applyMigrationFile("144_thread_channel_type.sql", migration)
			if newViolation {
				if err == nil || !strings.Contains(err.Error(), "introduced foreign key violation") {
					t.Fatalf("expected new FK violation rejection, got %v", err)
				}
			} else if err != nil {
				t.Fatalf("legacy orphans blocked migration: %v", err)
			}
			var rowID, enabled, records, orphanCount int
			var category sql.NullString
			var ddl string
			for _, check := range []struct {
				query string
				dest  any
			}{
				{`SELECT rowid FROM channels WHERE id='orphan'`, &rowID},
				{`SELECT category_id FROM channels WHERE id='healthy'`, &category},
				{`SELECT count(*) FROM legacy_orphans WHERE id=7 AND user_id='missing-user'`, &orphanCount},
				{`SELECT sql FROM sqlite_master WHERE name='channels'`, &ddl},
				{`PRAGMA foreign_keys`, &enabled},
				{`SELECT count(*) FROM schema_migrations WHERE filename='144_thread_channel_type.sql'`, &records},
			} {
				if err := conn.QueryRow(check.query).Scan(check.dest); err != nil {
					t.Fatal(err)
				}
			}
			if rowID != 42 || category.Valid || orphanCount != 1 || enabled != 0 {
				t.Fatalf("legacy data or FK setting changed: rowid=%d category=%v orphanCount=%d foreign_keys=%d", rowID, category, orphanCount, enabled)
			}
			if strings.Contains(ddl, "'thread'") == newViolation || records != map[bool]int{false: 1, true: 0}[newViolation] {
				t.Fatalf("schema/history not atomic: ddl=%s records=%d", ddl, records)
			}
		})
	}
}

func TestMigration144PreservesChannelDependentsAndRollsBack(t *testing.T) {
	for _, fail := range []bool{false, true} {
		name := "upgrade"
		if fail {
			name = "rollback"
		}
		t.Run(name, func(t *testing.T) {
			prior := fstest.MapFS{}
			entries, err := fs.ReadDir(EmbeddedMigrations, "migrations")
			if err != nil {
				t.Fatal(err)
			}
			for _, e := range entries {
				if e.Name() >= "144_" {
					continue
				}
				raw, err := fs.ReadFile(EmbeddedMigrations, "migrations/"+e.Name())
				if err != nil {
					t.Fatal(err)
				}
				prior[e.Name()] = &fstest.MapFile{Data: raw}
			}
			db, err := New(filepath.Join(t.TempDir(), "upgrade.db"), prior)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			for _, sql := range []string{
				`INSERT INTO users(id,username,password_hash) VALUES('u','legacy','x')`,
				`INSERT INTO servers(id,name,owner_id) VALUES('s','legacy','u')`,
				`INSERT INTO channels(id,name,type,server_id,topic,bitrate) VALUES('c','legacy','text','s','preserved topic',384000)`,
				`INSERT INTO roles(id,name,server_id) VALUES('r','legacy','s')`,
				`INSERT INTO messages(id,channel_id,user_id,content) VALUES('m','c','u','preserved message')`,
				`INSERT INTO attachments(id,message_id,filename,file_url) VALUES('a','m','proof.txt','/proof.txt')`,
				`INSERT INTO channel_permissions(channel_id,role_id,allow,deny) VALUES('c','r',32,16)`,
				`INSERT INTO pinned_messages(id,message_id,channel_id,pinned_by) VALUES('p','m','c','u')`,
				`INSERT INTO channel_reads(user_id,channel_id,last_read_message_id) VALUES('u','c','m')`,
				`INSERT INTO channel_mutes(user_id,channel_id,server_id) VALUES('u','c','s')`,
				`INSERT INTO channel_entrance_disabled(channel_id,server_id) VALUES('c','s')`,
				`INSERT INTO server_events(id,server_id,creator_id,name,starts_at,channel_id) VALUES('e','s','u','legacy','2026-12-01','c')`,
				`CREATE INDEX custom_channel_topic ON channels(topic)`,
			} {
				if _, err := db.Conn.Exec(sql); err != nil {
					t.Fatalf("seed %s: %v", sql, err)
				}
			}
			raw, err := fs.ReadFile(EmbeddedMigrations, "migrations/144_thread_channel_type.sql")
			if err != nil {
				t.Fatal(err)
			}
			content := string(raw)
			if fail {
				content += "\nINSERT INTO missing_table VALUES(1);"
			}
			err = db.applyMigrationFile("144_thread_channel_type.sql", content)
			if fail && err == nil || !fail && err != nil {
				t.Fatalf("migration fail=%v: %v", fail, err)
			}
			for _, table := range []string{"channels", "messages", "attachments", "channel_permissions", "pinned_messages", "channel_reads", "channel_mutes", "channel_entrance_disabled", "server_events"} {
				var count int
				if err := db.Conn.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 1 {
					t.Fatalf("%s count=%d err=%v", table, count, err)
				}
			}
			var message, topic, target string
			if err := db.Conn.QueryRow(`SELECT content FROM messages WHERE id='m'`).Scan(&message); err != nil || message != "preserved message" {
				t.Fatalf("message changed %q: %v", message, err)
			}
			if err := db.Conn.QueryRow(`SELECT topic FROM channels WHERE id='c'`).Scan(&topic); err != nil || topic != "preserved topic" {
				t.Fatalf("topic changed %q: %v", topic, err)
			}
			if err := db.Conn.QueryRow(`SELECT channel_id FROM server_events WHERE id='e'`).Scan(&target); err != nil || target != "c" {
				t.Fatalf("event reference changed %q: %v", target, err)
			}
			var enabled int
			if err := db.Conn.QueryRow(`PRAGMA foreign_keys`).Scan(&enabled); err != nil || enabled != 1 {
				t.Fatalf("foreign_keys=%d err=%v", enabled, err)
			}
			var customIndex int
			if err := db.Conn.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name='custom_channel_topic'`).Scan(&customIndex); err != nil || customIndex != 1 {
				t.Fatalf("custom index lost: %d %v", customIndex, err)
			}
			var ddl string
			if err := db.Conn.QueryRow(`SELECT sql FROM sqlite_master WHERE name='channels'`).Scan(&ddl); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(ddl, "'thread'") == fail {
				t.Fatalf("unexpected schema after fail=%v: %s", fail, ddl)
			}
			var recorded int
			if err := db.Conn.QueryRow(`SELECT count(*) FROM schema_migrations WHERE filename='144_thread_channel_type.sql'`).Scan(&recorded); err != nil || recorded != map[bool]int{true: 0, false: 1}[fail] {
				t.Fatalf("migration record=%d err=%v", recorded, err)
			}
			if !fail {
				if _, err := db.Conn.Exec(`INSERT INTO channels(id,name,type,server_id,parent_channel_id,starter_message_id) VALUES('thread','topic','thread','s','c','m')`); err != nil {
					t.Fatal(err)
				}
				if _, err := db.Conn.Exec(`DELETE FROM channels WHERE id='c'`); err != nil {
					t.Fatal(err)
				}
				var remaining int
				if err := db.Conn.QueryRow(`SELECT count(*) FROM channels`).Scan(&remaining); err != nil || remaining != 0 {
					t.Fatalf("channel cascade missing: %d %v", remaining, err)
				}
			}
		})
	}
}
