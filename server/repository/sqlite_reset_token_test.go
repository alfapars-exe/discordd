// Tests for sqliteResetTokenRepo — CRUD contracts plus the A-28 format
// guard: Create must bind a "YYYY-MM-DD HH:MM:SS" expires_at string, not the
// raw time.Time (see sqlite_reset_token.go). DB harness: testdb_test.go.
package repository

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

const resetTokenOwner = "u-reset-owner"

func seedResetTokenWorld(t testing.TB, db *database.DB) {
	t.Helper()
	execSeed(t, db, []seedStmt{
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`,
			[]any{resetTokenOwner, "reset-owner"}},
	})
}

// rawResetTokenExpiresAt reads the column's ACTUAL stored bytes via
// CAST(... AS TEXT) — see rawExpiresAt in sqlite_member_timeout_test.go for
// why a plain scan target would mask the on-disk format.
func rawResetTokenExpiresAt(t testing.TB, db *database.DB, tokenID string) string {
	t.Helper()
	var raw string
	if err := db.Conn.QueryRow(
		`SELECT CAST(expires_at AS TEXT) FROM password_reset_tokens WHERE id = ?`,
		tokenID,
	).Scan(&raw); err != nil {
		t.Fatalf("read raw expires_at: %v", err)
	}
	return raw
}

func TestResetTokenRepo_CreateAndGetByHash(t *testing.T) {
	db := newTestDB(t)
	seedResetTokenWorld(t, db)
	repo := NewSQLiteResetTokenRepo(wrapForRepo(db))
	ctx := context.Background()

	token := &models.PasswordResetToken{
		UserID:    resetTokenOwner,
		TokenHash: "hash-1",
		ExpiresAt: time.Now().Add(20 * time.Minute),
	}
	if err := repo.Create(ctx, token); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := repo.GetByTokenHash(ctx, "hash-1")
	if err != nil {
		t.Fatalf("GetByTokenHash: %v", err)
	}
	if got.UserID != resetTokenOwner {
		t.Errorf("UserID = %q, want %q", got.UserID, resetTokenOwner)
	}

	// Format guard.
	raw := rawResetTokenExpiresAt(t, db, got.ID)
	if !expiryFormatRe.MatchString(raw) {
		t.Errorf("stored expires_at = %q, want YYYY-MM-DD HH:MM:SS format (no 'T')", raw)
	}
}

func TestResetTokenRepo_DeleteExpired(t *testing.T) {
	db := newTestDB(t)
	seedResetTokenWorld(t, db)
	repo := NewSQLiteResetTokenRepo(wrapForRepo(db))
	ctx := context.Background()

	live := &models.PasswordResetToken{UserID: resetTokenOwner, TokenHash: "live", ExpiresAt: time.Now().Add(time.Hour)}
	if err := repo.Create(ctx, live); err != nil {
		t.Fatalf("create live: %v", err)
	}
	stale := &models.PasswordResetToken{UserID: resetTokenOwner, TokenHash: "stale", ExpiresAt: time.Now().Add(-time.Hour)}
	if err := repo.Create(ctx, stale); err != nil {
		t.Fatalf("create stale: %v", err)
	}

	if err := repo.DeleteExpired(ctx); err != nil {
		t.Fatalf("DeleteExpired: %v", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM password_reset_tokens WHERE user_id = ?`, resetTokenOwner); n != 1 {
		t.Errorf("after DeleteExpired: %d rows, want 1 (only the live one)", n)
	}
	if _, err := repo.GetByTokenHash(ctx, "live"); err != nil {
		t.Errorf("the live token must survive DeleteExpired: %v", err)
	}
}

// TestResetTokenRepo_Migration077_NormalizesLegacyRFC3339Row plants a
// pre-A-28-fix RFC3339 expires_at directly via raw SQL — bypassing Create,
// which now always writes the correct format — and proves 077 normalizes it,
// is idempotent, and that DeleteExpired (previously silently no-op on such
// rows) now actually deletes it.
func TestResetTokenRepo_Migration077_NormalizesLegacyRFC3339Row(t *testing.T) {
	db := newTestDB(t)
	seedResetTokenWorld(t, db)
	repo := NewSQLiteResetTokenRepo(wrapForRepo(db))
	ctx := context.Background()

	legacyExpiry := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	const tokenID = "legacy-reset-077"
	if _, err := db.Conn.Exec(
		`INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
		tokenID, resetTokenOwner, "legacy-hash", legacyExpiry,
	); err != nil {
		t.Fatalf("plant legacy RFC3339 row: %v", err)
	}

	raw := rawResetTokenExpiresAt(t, db, tokenID)
	if !strings.Contains(raw, "T") {
		t.Fatalf("setup: expected planted row to contain 'T' (RFC3339), got %q", raw)
	}

	exec077Migration(t, db)

	raw = rawResetTokenExpiresAt(t, db, tokenID)
	if !expiryFormatRe.MatchString(raw) {
		t.Errorf("after 077: expires_at = %q, want YYYY-MM-DD HH:MM:SS format", raw)
	}

	if err := repo.DeleteExpired(ctx); err != nil {
		t.Fatalf("DeleteExpired: %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM password_reset_tokens WHERE id = ?`, tokenID); n != 0 {
		t.Errorf("expected the normalized expired token to be deleted, %d rows remain", n)
	}

	// Idempotent: running it again must not error.
	exec077Migration(t, db)
}
