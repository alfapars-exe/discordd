// sqliteUserNoteRepo against a real local SQLite database (migration 084).
// DB harness: testdb_test.go.
package repository

import (
	"context"
	"github.com/argeinfina/hichat/database"
	"testing"
)

func TestUserNoteRepo_GetUpsertDelete(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteUserNoteRepo(wrapForRepo(db))
	ctx := context.Background()

	note, updatedAt, err := repo.Get(ctx, dmAlice, dmBob)
	if err != nil {
		t.Fatalf("Get(empty): %v", err)
	}
	if note != "" || updatedAt != nil {
		t.Errorf("Get(empty) = (%q, %v), want (\"\", nil)", note, updatedAt)
	}

	first, err := repo.Upsert(ctx, dmAlice, dmBob, "met at the meetup")
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	assertRFC3339UTC(t, "Upsert updated_at", first)

	note, updatedAt, err = repo.Get(ctx, dmAlice, dmBob)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if note != "met at the meetup" || updatedAt == nil || *updatedAt != first {
		t.Errorf("Get = (%q, %v), want the stored note with updated_at %q", note, updatedAt, first)
	}

	// Direction matters: bob has no note about alice.
	if n, ts, err := repo.Get(ctx, dmBob, dmAlice); err != nil || n != "" || ts != nil {
		t.Errorf("Get(reverse) = (%q, %v, %v), want empty", n, ts, err)
	}

	// Upsert replaces in place: still one row, new text, timestamp moved on
	// (backdated first so the second write is observably newer).
	if _, err := db.Conn.Exec(`UPDATE user_notes SET updated_at = '2000-01-01 00:00:00' WHERE owner_user_id = ? AND target_user_id = ?`, dmAlice, dmBob); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	second, err := repo.Upsert(ctx, dmAlice, dmBob, "works at acme")
	if err != nil {
		t.Fatalf("Upsert(replace): %v", err)
	}
	if second == "2000-01-01T00:00:00Z" {
		t.Error("replacing upsert did not refresh updated_at")
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM user_notes WHERE owner_user_id = ?`, dmAlice); n != 1 {
		t.Errorf("rows after replace = %d, want 1", n)
	}
	note, _, _ = repo.Get(ctx, dmAlice, dmBob)
	if note != "works at acme" {
		t.Errorf("note after replace = %q", note)
	}
	// Stored form stays the DB's space-separated text — only the boundary converts.
	storageQuery := `SELECT COUNT(*) FROM user_notes WHERE owner_user_id = ? AND updated_at LIKE '____-__-__ __:__:__'`
	if database.IsPostgres(db.Conn) {
		storageQuery = `SELECT COUNT(*) FROM user_notes WHERE owner_user_id = ? AND updated_at IS NOT NULL AND pg_typeof(updated_at) = 'timestamptz'::regtype`
	}
	if n := countRows(t, db, storageQuery, dmAlice); n != 1 {
		t.Error("stored updated_at is not 'YYYY-MM-DD HH:MM:SS' text")
	}

	if err := repo.Delete(ctx, dmAlice, dmBob); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := repo.Delete(ctx, dmAlice, dmBob); err != nil {
		t.Errorf("Delete(missing) = %v, want nil", err)
	}
	if n, ts, _ := repo.Get(ctx, dmAlice, dmBob); n != "" || ts != nil {
		t.Errorf("Get after delete = (%q, %v), want empty", n, ts)
	}
}
