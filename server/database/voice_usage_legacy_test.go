package database

import (
	"strings"
	"testing"
	"testing/fstest"
)

func usageLegacyBundle(t *testing.T, includeUsage bool) fstest.MapFS {
	t.Helper()
	entries, err := EmbeddedMigrations.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".sql") || (!includeUsage && name > "150_dm_attachment_order.sql") {
			continue
		}
		data, err := EmbeddedMigrations.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		files[name] = &fstest.MapFile{Data: data}
	}
	return files
}
func TestVoiceUsageLegacyBootstrapCreatesImportLedger(t *testing.T) {
	db := newRunnerTestDB(t)
	if err := db.runMigrations(usageLegacyBundle(t, false)); err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, "DELETE FROM schema_migrations")
	files := usageLegacyBundle(t, true)
	if err := db.runMigrations(files); err != nil {
		t.Fatal(err)
	}
	if got := count(t, db, "SELECT count(*) FROM voice_usage_credits"); got != 0 {
		t.Fatalf("legacy bootstrap fabricated %d credits", got)
	}
	mustExec(t, db, "SELECT applied_at FROM voice_usage_credits")
	if err := db.runMigrations(files); err != nil {
		t.Fatalf("repeat legacy startup: %v", err)
	}
}
