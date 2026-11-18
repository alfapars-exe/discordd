package database

import (
	"os"
	"strings"
	"testing"
	"testing/fstest"
)

func TestLegacyBaselinesMatchHistoricalUpgrades(t *testing.T) {
	entries, err := os.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{}
	db := newRunnerTestDB(t)
	verified := 0
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		data, err := os.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		files[name] = &fstest.MapFile{Data: data}
		if name < "144_" {
			continue
		}
		if err := db.runMigrations(files); err != nil {
			t.Fatal(err)
		}
		mustExec(t, db, "DELETE FROM schema_migrations")
		if name == "144_thread_channel_type.sql" {
			files[name].Data = append(append([]byte(nil), data...), []byte("\n-- altered")...)
			if err := db.runMigrations(files); err == nil {
				t.Fatal("accepted altered migration bundle")
			}
			if count(t, db, "SELECT count(*) FROM schema_migrations") != 0 {
				t.Fatal("altered bundle wrote history")
			}
			files[name].Data = data
		}
		if err := db.runMigrations(files); err != nil {
			t.Fatalf("adopt %s: %v", name, err)
		}
		if count(t, db, "SELECT count(*) FROM schema_migrations") != len(files) {
			t.Fatalf("incomplete history at %s", name)
		}
		verified++
		if name == "150_dm_attachment_order.sql" {
			break
		}
	}
	if verified != len(legacyBaselines) {
		t.Fatalf("verified %d baselines, expected %d", verified, len(legacyBaselines))
	}
	mustExec(t, db, "DELETE FROM schema_migrations")
	mustExec(t, db, "CREATE INDEX unknown_legacy_index ON users(username)")
	if err := db.runMigrations(files); err == nil || count(t, db, "SELECT count(*) FROM schema_migrations") != 0 {
		t.Fatal("adopted an edited historical schema")
	}
	mustExec(t, db, "DROP INDEX unknown_legacy_index")
	mustExec(t, db, "DROP TABLE schema_migrations")
	mustExec(t, db, "CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY CHECK(filename NOT LIKE '050%'), applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)")
	if err := db.runMigrations(files); err == nil {
		t.Fatal("expected history insertion failure")
	}
	if count(t, db, "SELECT count(*) FROM schema_migrations") != 0 {
		t.Fatal("partial adoption survived rollback")
	}
}

func TestLegacyAdoptionAppliesMigrationsAfterKnownPrefix(t *testing.T) {
	db := newRunnerTestDB(t)
	files := fstest.MapFS{}
	entries, err := os.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".sql") || name > "144_thread_channel_type.sql" {
			continue
		}
		data, err := os.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		files[name] = &fstest.MapFile{Data: data}
	}
	if err := db.runMigrations(files); err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, "INSERT INTO users(id,username,password_hash) VALUES('legacy','preserved','x')")
	mustExec(t, db, "DELETE FROM schema_migrations")
	for i := 0; i < 2; i++ {
		if err := db.runMigrations(os.DirFS("migrations")); err != nil {
			t.Fatal(err)
		}
	}
	if count(t, db, "SELECT count(*) FROM schema_migrations WHERE filename='150_dm_attachment_order.sql'") != 1 ||
		count(t, db, "SELECT count(*) FROM users WHERE id='legacy' AND username='preserved'") != 1 {
		t.Fatal("missing upgrade history or lost legacy user")
	}
}
