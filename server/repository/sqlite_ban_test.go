// Tests for sqliteBanRepo — permanent vs. temp ban expiry filtering, and the
// A1 format guard: Create must bind a nil-safe "YYYY-MM-DD HH:MM:SS" string
// (or SQL NULL for permanent bans), not a raw *time.Time (which go-libsql
// would write as RFC3339 — see sqlite_ban.go). DB harness: testdb_test.go.
package repository

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

const (
	banServer = "srv-ban"
	banOwner  = "u-ban-owner"
	banTarget = "u-ban-target"
	banActor  = "u-ban-actor"
)

func seedBanWorld(t testing.TB, db *database.DB) {
	t.Helper()
	execSeed(t, db, []seedStmt{
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`,
			[]any{banOwner, "ban-owner"}},
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`,
			[]any{banTarget, "ban-target"}},
		{`INSERT INTO servers (id, name, owner_id) VALUES (?, ?, ?)`,
			[]any{banServer, "Ban Server", banOwner}},
	})
}

// rawBanExpiresAt reads the column's ACTUAL stored bytes (nil for SQL NULL
// on a permanent ban). Scanning a DATETIME column straight into a Go string
// lets modernc.org/sqlite parse it into a time.Time first and database/sql
// then reformat it back to a string (RFC3339Nano) on the way out — so a
// plain scan target always shows 'T', regardless of what is really on disk.
// CAST(... AS TEXT) forces SQLite itself to hand back the stored text
// verbatim (still NULL for a permanent ban), bypassing that driver-side
// round trip.
func rawBanExpiresAt(t testing.TB, db *database.DB, serverID, userID string) *string {
	t.Helper()
	var raw *string
	if err := db.Conn.QueryRow(
		`SELECT CAST(expires_at AS TEXT) FROM bans WHERE server_id = ? AND user_id = ?`,
		serverID, userID,
	).Scan(&raw); err != nil {
		t.Fatalf("read raw expires_at: %v", err)
	}
	return raw
}

func TestBanRepo_Permanent(t *testing.T) {
	db := newTestDB(t)
	seedBanWorld(t, db)
	repo := NewSQLiteBanRepo(wrapForRepo(db))
	ctx := context.Background()

	if err := repo.Create(ctx, &models.Ban{
		ServerID: banServer, UserID: banTarget, Username: "ban-target",
		Reason: "raid", BannedBy: banActor, ExpiresAt: nil,
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}

	exists, err := repo.Exists(ctx, banServer, banTarget)
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}
	if !exists {
		t.Error("expected a permanent ban to be active")
	}

	got, err := repo.GetByUserID(ctx, banServer, banTarget)
	if err != nil {
		t.Fatalf("GetByUserID: %v", err)
	}
	if got.ExpiresAt != nil {
		t.Errorf("expected nil ExpiresAt for a permanent ban, got %v", *got.ExpiresAt)
	}

	all, err := repo.GetAllByServer(ctx, banServer)
	if err != nil {
		t.Fatalf("GetAllByServer: %v", err)
	}
	if len(all) != 1 || all[0].UserID != banTarget {
		t.Errorf("GetAllByServer = %+v, want exactly [%s]", all, banTarget)
	}

	// Format guard: expires_at stays SQL NULL for a permanent ban.
	if raw := rawBanExpiresAt(t, db, banServer, banTarget); raw != nil {
		t.Errorf("expected NULL expires_at for a permanent ban, got %q", *raw)
	}
}

func TestBanRepo_TempFuture_Active(t *testing.T) {
	db := newTestDB(t)
	seedBanWorld(t, db)
	repo := NewSQLiteBanRepo(wrapForRepo(db))
	ctx := context.Background()

	expiry := time.Now().UTC().Add(1 * time.Hour)
	if err := repo.Create(ctx, &models.Ban{
		ServerID: banServer, UserID: banTarget, Username: "ban-target",
		Reason: "spam", BannedBy: banActor, ExpiresAt: &expiry,
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}

	exists, err := repo.Exists(ctx, banServer, banTarget)
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}
	if !exists {
		t.Error("expected a future-expiring temp ban to be active")
	}

	got, err := repo.GetByUserID(ctx, banServer, banTarget)
	if err != nil {
		t.Fatalf("GetByUserID: %v", err)
	}
	if got.ExpiresAt == nil {
		t.Fatal("expected non-nil ExpiresAt for a temp ban")
	}

	// Format guard.
	raw := rawBanExpiresAt(t, db, banServer, banTarget)
	if raw == nil || !expiryFormatRe.MatchString(*raw) {
		t.Errorf("stored expires_at = %v, want YYYY-MM-DD HH:MM:SS format (no 'T')", raw)
	}
}

func TestBanRepo_TempPast_NotActive(t *testing.T) {
	db := newTestDB(t)
	seedBanWorld(t, db)
	repo := NewSQLiteBanRepo(wrapForRepo(db))
	ctx := context.Background()

	expiry := time.Now().UTC().Add(-1 * time.Second)
	if err := repo.Create(ctx, &models.Ban{
		ServerID: banServer, UserID: banTarget, Username: "ban-target",
		Reason: "old", BannedBy: banActor, ExpiresAt: &expiry,
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}

	exists, err := repo.Exists(ctx, banServer, banTarget)
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}
	if exists {
		t.Error("expected an already-expired temp ban to be inactive")
	}

	_, err = repo.GetByUserID(ctx, banServer, banTarget)
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("GetByUserID for expired ban: expected ErrNotFound, got %v", err)
	}

	all, err := repo.GetAllByServer(ctx, banServer)
	if err != nil {
		t.Fatalf("GetAllByServer: %v", err)
	}
	if len(all) != 0 {
		t.Errorf("GetAllByServer = %+v, want empty (expired ban excluded)", all)
	}
}

// TestBanRepo_ReBan_ReplacesRow pins the INSERT OR REPLACE contract: banning
// an already-banned user again keeps exactly one row and updates the expiry.
func TestBanRepo_ReBan_ReplacesRow(t *testing.T) {
	db := newTestDB(t)
	seedBanWorld(t, db)
	repo := NewSQLiteBanRepo(wrapForRepo(db))
	ctx := context.Background()

	first := time.Now().UTC().Add(10 * time.Minute)
	if err := repo.Create(ctx, &models.Ban{
		ServerID: banServer, UserID: banTarget, Username: "ban-target",
		Reason: "first", BannedBy: banActor, ExpiresAt: &first,
	}); err != nil {
		t.Fatalf("first Create: %v", err)
	}

	second := time.Now().UTC().Add(2 * time.Hour)
	if err := repo.Create(ctx, &models.Ban{
		ServerID: banServer, UserID: banTarget, Username: "ban-target",
		Reason: "extended", BannedBy: banActor, ExpiresAt: &second,
	}); err != nil {
		t.Fatalf("second Create: %v", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM bans WHERE server_id = ? AND user_id = ?`, banServer, banTarget); n != 1 {
		t.Fatalf("expected exactly 1 row after re-ban, got %d", n)
	}

	got, err := repo.GetByUserID(ctx, banServer, banTarget)
	if err != nil {
		t.Fatalf("GetByUserID: %v", err)
	}
	if got.Reason != "extended" {
		t.Errorf("Reason = %q, want %q", got.Reason, "extended")
	}
	if got.ExpiresAt == nil || got.ExpiresAt.Truncate(time.Second) != second.Truncate(time.Second) {
		t.Errorf("ExpiresAt = %v, want ~%v", got.ExpiresAt, second)
	}
}

// ─── Migration 076 normalization (A2) ───

// TestBanRepo_Migration076_NormalizesLegacyRFC3339Row mirrors
// TestMemberTimeoutRepo_Migration076_NormalizesLegacyRFC3339Row for the bans
// table: a pre-A1-fix RFC3339 expires_at planted via raw SQL must be
// normalized by 076, must read as expired afterwards, and 076 must be
// idempotent on a second run.
func TestBanRepo_Migration076_NormalizesLegacyRFC3339Row(t *testing.T) {
	db := newTestDB(t)
	seedBanWorld(t, db)
	repo := NewSQLiteBanRepo(wrapForRepo(db))
	ctx := context.Background()

	legacyExpiry := time.Now().UTC().Add(-1 * time.Minute).Format(time.RFC3339)
	if _, err := db.Conn.Exec(
		`INSERT INTO bans (server_id, user_id, username, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
		banServer, banTarget, "ban-target", "legacy", banActor, legacyExpiry,
	); err != nil {
		t.Fatalf("plant legacy RFC3339 row: %v", err)
	}

	raw := rawBanExpiresAt(t, db, banServer, banTarget)
	if raw == nil || !strings.Contains(*raw, "T") {
		t.Fatalf("setup: expected planted row to contain 'T' (RFC3339), got %v", raw)
	}

	exec076Migration(t, db)

	raw = rawBanExpiresAt(t, db, banServer, banTarget)
	if raw == nil || !expiryFormatRe.MatchString(*raw) {
		t.Errorf("after 076: expires_at = %v, want YYYY-MM-DD HH:MM:SS format", raw)
	}
	exists, err := repo.Exists(ctx, banServer, banTarget)
	if err != nil {
		t.Fatalf("Exists after 076: %v", err)
	}
	if exists {
		t.Error("expected the normalized-and-already-past ban to read as inactive")
	}

	// Idempotent: running it again must not error and must not change the value.
	exec076Migration(t, db)
	raw2 := rawBanExpiresAt(t, db, banServer, banTarget)
	if raw2 == nil || *raw2 != *raw {
		t.Errorf("076 is not idempotent: first=%v second=%v", raw, raw2)
	}
}

// TestBanRepo_Migration076_LeavesPermanentBanNull is a negative case: 076's
// WHERE clause requires expires_at IS NOT NULL for the bans table — a
// permanent ban's NULL row must be left untouched (COALESCE/datetime(NULL)
// would otherwise be a landmine if the WHERE guard were ever dropped).
func TestBanRepo_Migration076_LeavesPermanentBanNull(t *testing.T) {
	db := newTestDB(t)
	seedBanWorld(t, db)
	repo := NewSQLiteBanRepo(wrapForRepo(db))
	ctx := context.Background()

	if err := repo.Create(ctx, &models.Ban{
		ServerID: banServer, UserID: banTarget, Username: "ban-target",
		Reason: "permanent", BannedBy: banActor, ExpiresAt: nil,
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}

	exec076Migration(t, db)

	if raw := rawBanExpiresAt(t, db, banServer, banTarget); raw != nil {
		t.Errorf("expected permanent ban's expires_at to stay NULL after 076, got %q", *raw)
	}
	exists, err := repo.Exists(ctx, banServer, banTarget)
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}
	if !exists {
		t.Error("permanent ban must remain active after 076")
	}
}
