// Tests for sqliteMemberTimeoutRepo — expiry filtering (Get/IsActive/
// ListActive all hide expired rows) and the A1 format guard: Upsert must
// bind a "YYYY-MM-DD HH:MM:SS" string, not a raw time.Time (which go-libsql
// would write as RFC3339 and which never compares correctly against
// sqlite's datetime('now') output — see sqlite_member_timeout.go). DB
// harness: testdb_test.go.
package repository

import (
	"context"
	"io/fs"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

const (
	mtServer = "srv-mt"
	mtOwner  = "u-mt-owner"
	mtTarget = "u-mt-target"
	mtActor  = "u-mt-actor"
)

// seedMemberTimeoutWorld plants the FK chain member_timeouts depends on:
// server_id REFERENCES servers(id), user_id REFERENCES users(id), and
// servers.owner_id REFERENCES users(id) in turn.
func seedMemberTimeoutWorld(t testing.TB, db *database.DB) {
	t.Helper()
	execSeed(t, db, []seedStmt{
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`,
			[]any{mtOwner, "mt-owner"}},
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`,
			[]any{mtTarget, "mt-target"}},
		{`INSERT INTO servers (id, name, owner_id) VALUES (?, ?, ?)`,
			[]any{mtServer, "MT Server", mtOwner}},
	})
}

// expiryFormatRe pins the A1 contract: expires_at must be a plain
// "YYYY-MM-DD HH:MM:SS" string — no 'T' separator, no 'Z'/offset suffix.
var expiryFormatRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$`)

// rawExpiresAt reads the column's ACTUAL stored bytes. Scanning a DATETIME
// column straight into a Go string lets modernc.org/sqlite parse it into a
// time.Time first and database/sql then reformat it back to a string
// (RFC3339Nano) on the way out — so a plain `string` scan target always
// shows 'T', regardless of what is really on disk. CAST(... AS TEXT) forces
// SQLite itself to hand back the stored text verbatim, bypassing that
// driver-side round trip.
func rawExpiresAt(t testing.TB, db *database.DB, serverID, userID string) string {
	t.Helper()
	var raw string
	if err := db.Conn.QueryRow(
		`SELECT CAST(expires_at AS TEXT) FROM member_timeouts WHERE server_id = ? AND user_id = ?`,
		serverID, userID,
	).Scan(&raw); err != nil {
		t.Fatalf("read raw expires_at: %v", err)
	}
	return raw
}

func TestMemberTimeoutRepo_FutureExpiry_IsActive(t *testing.T) {
	db := newTestDB(t)
	seedMemberTimeoutWorld(t, db)
	repo := NewSQLiteMemberTimeoutRepo(wrapForRepo(db))
	ctx := context.Background()

	expiry := time.Now().UTC().Add(1 * time.Hour)
	if err := repo.Upsert(ctx, &models.MemberTimeout{
		ServerID: mtServer, UserID: mtTarget, ExpiresAt: expiry, AppliedBy: mtActor, Reason: "spam",
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	active, err := repo.IsActive(ctx, mtServer, mtTarget)
	if err != nil {
		t.Fatalf("IsActive: %v", err)
	}
	if !active {
		t.Error("expected IsActive=true for a future-expiring timeout")
	}

	got, err := repo.Get(ctx, mtServer, mtTarget)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil {
		t.Fatal("expected non-nil Get result for a future-expiring timeout")
	}
	if got.Reason != "spam" || got.AppliedBy != mtActor {
		t.Errorf("Get returned unexpected row: %+v", got)
	}

	list, err := repo.ListActive(ctx, mtServer)
	if err != nil {
		t.Fatalf("ListActive: %v", err)
	}
	if len(list) != 1 || list[0].UserID != mtTarget {
		t.Errorf("ListActive = %+v, want exactly [%s]", list, mtTarget)
	}

	// Format guard.
	raw := rawExpiresAt(t, db, mtServer, mtTarget)
	if !expiryFormatRe.MatchString(raw) {
		t.Errorf("stored expires_at = %q, want YYYY-MM-DD HH:MM:SS format (no 'T')", raw)
	}
}

func TestMemberTimeoutRepo_PastExpiry_NotActive(t *testing.T) {
	db := newTestDB(t)
	seedMemberTimeoutWorld(t, db)
	repo := NewSQLiteMemberTimeoutRepo(wrapForRepo(db))
	ctx := context.Background()

	expiry := time.Now().UTC().Add(-1 * time.Second)
	if err := repo.Upsert(ctx, &models.MemberTimeout{
		ServerID: mtServer, UserID: mtTarget, ExpiresAt: expiry, AppliedBy: mtActor, Reason: "old",
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	active, err := repo.IsActive(ctx, mtServer, mtTarget)
	if err != nil {
		t.Fatalf("IsActive: %v", err)
	}
	if active {
		t.Error("expected IsActive=false for an already-expired timeout")
	}

	got, err := repo.Get(ctx, mtServer, mtTarget)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil Get result for an expired timeout, got %+v", got)
	}

	list, err := repo.ListActive(ctx, mtServer)
	if err != nil {
		t.Fatalf("ListActive: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("ListActive = %+v, want empty for an expired timeout", list)
	}
}

// TestMemberTimeoutRepo_UpsertExtends pins the INSERT OR REPLACE contract:
// re-timing an already timed-out user keeps exactly one row and moves the
// expiry forward.
func TestMemberTimeoutRepo_UpsertExtends(t *testing.T) {
	db := newTestDB(t)
	seedMemberTimeoutWorld(t, db)
	repo := NewSQLiteMemberTimeoutRepo(wrapForRepo(db))
	ctx := context.Background()

	first := time.Now().UTC().Add(5 * time.Minute)
	if err := repo.Upsert(ctx, &models.MemberTimeout{
		ServerID: mtServer, UserID: mtTarget, ExpiresAt: first, AppliedBy: mtActor, Reason: "first",
	}); err != nil {
		t.Fatalf("first Upsert: %v", err)
	}

	second := time.Now().UTC().Add(1 * time.Hour)
	if err := repo.Upsert(ctx, &models.MemberTimeout{
		ServerID: mtServer, UserID: mtTarget, ExpiresAt: second, AppliedBy: mtActor, Reason: "extended",
	}); err != nil {
		t.Fatalf("second Upsert: %v", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM member_timeouts WHERE server_id = ? AND user_id = ?`, mtServer, mtTarget); n != 1 {
		t.Fatalf("expected exactly 1 row after re-timing, got %d", n)
	}

	got, err := repo.Get(ctx, mtServer, mtTarget)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil {
		t.Fatal("expected non-nil Get after extension")
	}
	if got.Reason != "extended" {
		t.Errorf("Reason = %q, want %q", got.Reason, "extended")
	}
	// Compare to the second (rounding to the second — the stored format has
	// no sub-second precision).
	if got.ExpiresAt.Truncate(time.Second) != second.Truncate(time.Second) {
		t.Errorf("ExpiresAt = %v, want ~%v", got.ExpiresAt, second)
	}
}

func TestMemberTimeoutRepo_DeleteIdempotent(t *testing.T) {
	db := newTestDB(t)
	seedMemberTimeoutWorld(t, db)
	repo := NewSQLiteMemberTimeoutRepo(wrapForRepo(db))
	ctx := context.Background()

	if err := repo.Upsert(ctx, &models.MemberTimeout{
		ServerID: mtServer, UserID: mtTarget, ExpiresAt: time.Now().UTC().Add(time.Hour), AppliedBy: mtActor,
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	if err := repo.Delete(ctx, mtServer, mtTarget); err != nil {
		t.Fatalf("first Delete: %v", err)
	}
	if active, err := repo.IsActive(ctx, mtServer, mtTarget); err != nil || active {
		t.Fatalf("expected inactive after Delete, active=%v err=%v", active, err)
	}
	// Deleting again (no row left) must not error.
	if err := repo.Delete(ctx, mtServer, mtTarget); err != nil {
		t.Fatalf("second (no-op) Delete: %v", err)
	}
}

// ─── Migration 076 normalization (A2) ───

// read076Migration returns the real embedded migration SQL so the test
// exercises the exact statements that ship, not a hand-copied approximation.
func read076Migration(t testing.TB) string {
	t.Helper()
	content, err := fs.ReadFile(database.EmbeddedMigrations, "migrations/076_fix_moderation_expiry_format.sql")
	if err != nil {
		t.Fatalf("read embedded migration 076: %v", err)
	}
	return string(content)
}

// exec076Migration runs 076's statements against db directly (not through the
// migration runner — newTestDB already applied every migration once as part
// of boot, so 076 has already run against an empty member_timeouts/bans
// table). This simulates re-running 076 by hand against a row planted
// AFTER boot, which is the only way to test its UPDATE logic against a
// pre-existing legacy (RFC3339) row without a second migrations table entry.
//
// Runs the whole file text in a single Exec rather than splitting on ";" —
// a naive split breaks inside the leading "--" comment block, which itself
// contains sentence-ending semicolons (e.g. "...time.Time binding; they
// never compare..."), producing a syntactically invalid fragment. The
// modernc driver (like the production migration runner) accepts a
// multi-statement script in one Exec call.
func exec076Migration(t testing.TB, db *database.DB) {
	t.Helper()
	if _, err := db.Conn.Exec(read076Migration(t)); err != nil {
		t.Fatalf("exec 076 migration: %v", err)
	}
}

// TestMemberTimeoutRepo_Migration076_NormalizesLegacyRFC3339Row plants a
// pre-A1-fix row (RFC3339 expires_at, as go-libsql's raw time.Time binding
// used to write) directly via raw SQL — bypassing Upsert, which now always
// writes the correct format — and proves 076 normalizes it in place, is
// idempotent on a second run, and that the row correctly reads as expired
// afterwards.
func TestMemberTimeoutRepo_Migration076_NormalizesLegacyRFC3339Row(t *testing.T) {
	db := newTestDB(t)
	seedMemberTimeoutWorld(t, db)
	repo := NewSQLiteMemberTimeoutRepo(wrapForRepo(db))
	ctx := context.Background()

	legacyExpiry := time.Now().UTC().Add(-1 * time.Minute).Format(time.RFC3339)
	if _, err := db.Conn.Exec(
		`INSERT INTO member_timeouts (server_id, user_id, expires_at, applied_by, reason) VALUES (?, ?, ?, ?, ?)`,
		mtServer, mtTarget, legacyExpiry, mtActor, "legacy",
	); err != nil {
		t.Fatalf("plant legacy RFC3339 row: %v", err)
	}

	raw := rawExpiresAt(t, db, mtServer, mtTarget)
	if !strings.Contains(raw, "T") {
		t.Fatalf("setup: expected planted row to contain 'T' (RFC3339), got %q", raw)
	}

	exec076Migration(t, db)

	raw = rawExpiresAt(t, db, mtServer, mtTarget)
	if !expiryFormatRe.MatchString(raw) {
		t.Errorf("after 076: expires_at = %q, want YYYY-MM-DD HH:MM:SS format", raw)
	}
	active, err := repo.IsActive(ctx, mtServer, mtTarget)
	if err != nil {
		t.Fatalf("IsActive after 076: %v", err)
	}
	if active {
		t.Error("expected the normalized-and-already-past row to read as inactive")
	}

	// Idempotent: running it again must not error and must not change the value.
	exec076Migration(t, db)
	raw2 := rawExpiresAt(t, db, mtServer, mtTarget)
	if raw2 != raw {
		t.Errorf("076 is not idempotent: first=%q second=%q", raw, raw2)
	}
}
