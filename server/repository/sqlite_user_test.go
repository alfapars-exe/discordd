// sqlite_user_test.go — real-DB tests for the A3/A4 register-path fix
// (RETURNING removed from the write path; ID generated in Go; user+session
// commit atomically). Runs against a real local SQLite database via
// newTestDB, same harness as the rest of this package's *_test.go files.
package repository

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// hexID16 matches the shape SQLite's lower(hex(randomblob(8))) produces:
// 16 lowercase hex characters (8 random bytes).
var hexID16 = regexp.MustCompile(`^[0-9a-f]{16}$`)

func newTestUser(username string) *models.User {
	return &models.User{
		Username:     username,
		PasswordHash: "hashed-password",
		Status:       models.UserStatusOnline,
		Language:     "en",
	}
}

func TestSQLiteUserCreate_IDShape(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteUserRepo(db.Conn)

	user := newTestUser("id-shape-user")
	if err := repo.Create(context.Background(), user); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if !hexID16.MatchString(user.ID) {
		t.Errorf("user.ID = %q, want 16 lowercase hex chars (same shape as lower(hex(randomblob(8))))", user.ID)
	}
}

func TestSQLiteUserCreate_CreatedAtIsDBFormat(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteUserRepo(db.Conn)

	user := newTestUser("created-at-user")
	if err := repo.Create(context.Background(), user); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if user.CreatedAt.IsZero() {
		t.Fatal("expected CreatedAt to be populated by the best-effort read-back")
	}

	// Read the raw column value back independently of the struct scan and
	// confirm it's SQLite's "YYYY-MM-DD HH:MM:SS" text, not RFC3339 — a
	// time.Time bind from Go would have written "T"/"Z"/"+00:00" into the
	// same column, silently mixing two date-string formats and breaking any
	// string-ordered range query across old and new rows.
	// CAST(... AS TEXT) is required: the column is declared DATETIME, and
	// modernc.org/sqlite converts declared date/time columns to time.Time on
	// read, so scanning it into a string yields the driver's RFC3339
	// re-rendering rather than the bytes actually stored. The cast forces
	// SQLite to hand back the raw stored text, which is what this test is
	// about.
	var raw string
	if err := db.Conn.QueryRow(`SELECT CAST(created_at AS TEXT) FROM users WHERE id = ?`, user.ID).Scan(&raw); err != nil {
		t.Fatalf("read back created_at: %v", err)
	}
	if strings.Contains(raw, "T") || strings.Contains(raw, "Z") || strings.Contains(raw, "+00:00") {
		t.Errorf("created_at = %q looks like RFC3339, want SQLite's default DATETIME text format", raw)
	}
}

func TestSQLiteUserCreate_DuplicateUsername(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteUserRepo(db.Conn)
	ctx := context.Background()

	if err := repo.Create(ctx, newTestUser("dupe-user")); err != nil {
		t.Fatalf("first Create: %v", err)
	}

	err := repo.Create(ctx, newTestUser("dupe-user"))
	if !errors.Is(err, pkg.ErrAlreadyExists) {
		t.Fatalf("second Create with duplicate username: got %v, want errors.Is(err, pkg.ErrAlreadyExists)", err)
	}
}

func TestSQLiteUserCreate_DuplicateEmail(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteUserRepo(db.Conn)
	ctx := context.Background()

	email := "dupe@example.com"

	first := newTestUser("email-user-1")
	first.Email = &email
	if err := repo.Create(ctx, first); err != nil {
		t.Fatalf("first Create: %v", err)
	}

	second := newTestUser("email-user-2")
	second.Email = &email
	err := repo.Create(ctx, second)
	if !errors.Is(err, pkg.ErrAlreadyExists) {
		t.Fatalf("second Create with duplicate email: got %v, want errors.Is(err, pkg.ErrAlreadyExists)", err)
	}
}

func TestSQLiteUserCreateWithSession_HappyPath(t *testing.T) {
	db := newTestDB(t)
	// Through the production retry wrapper (wrapForRepo) so rawDB = RawDB(db)
	// must unwrap to reach *sql.DB — the path that broke in prod 2026-07-19.
	repo := NewSQLiteUserRepo(wrapForRepo(db))
	ctx := context.Background()

	user := newTestUser("atomic-happy-user")
	session := &models.Session{
		RefreshToken: "refresh-token-happy-path",
	}

	if err := repo.CreateWithSession(ctx, user, session); err != nil {
		t.Fatalf("CreateWithSession: %v", err)
	}

	if !hexID16.MatchString(user.ID) {
		t.Errorf("user.ID = %q, want 16 lowercase hex chars", user.ID)
	}
	if !hexID16.MatchString(session.ID) {
		t.Errorf("session.ID = %q, want 16 lowercase hex chars", session.ID)
	}
	if session.UserID != user.ID {
		t.Errorf("session.UserID = %q, want %q", session.UserID, user.ID)
	}

	userCount := countRows(t, db, `SELECT COUNT(*) FROM users WHERE id = ?`, user.ID)
	if userCount != 1 {
		t.Errorf("expected exactly 1 user row for %s, got %d", user.ID, userCount)
	}
	sessionCount := countRows(t, db, `SELECT COUNT(*) FROM sessions WHERE id = ?`, session.ID)
	if sessionCount != 1 {
		t.Errorf("expected exactly 1 session row for %s, got %d", session.ID, sessionCount)
	}
}

// TestSQLiteUserCreateWithSession_RollsBackUserOnSessionFailure is the
// concrete regression pin for A4: before this fix, user-insert and
// session-insert were separate autocommit statements, so a failing session
// insert left a committed, tokenless user row behind. Here we force the
// session insert to fail (by pre-seeding a session with the same
// refresh_token_hash, tripping idx_sessions_refresh_token_hash) and assert
// the user row was never persisted either.
func TestSQLiteUserCreateWithSession_RollsBackUserOnSessionFailure(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteUserRepo(wrapForRepo(db)) // wrapped, like prod (see wrapForRepo)
	ctx := context.Background()

	const refreshToken = "refresh-token-collision"

	// Pre-seed a session row with the exact hash CreateWithSession will
	// compute for refreshToken, using the same hashRefreshToken function so
	// the collision is real rather than a hardcoded guess.
	hash := hashRefreshToken(refreshToken)
	seedUser := newTestUser("pre-seed-owner")
	if err := repo.Create(ctx, seedUser); err != nil {
		t.Fatalf("seed owner Create: %v", err)
	}
	execSeed(t, db, []seedStmt{
		{
			q: `INSERT INTO sessions (id, user_id, refresh_token_hash, refresh_token, expires_at)
				VALUES ('preexisting0000', ?, ?, ?, datetime('now', '+1 day'))`,
			args: []any{seedUser.ID, hash, hash},
		},
	})

	victim := newTestUser("atomic-rollback-user")
	session := &models.Session{
		RefreshToken: refreshToken,
	}

	err := repo.CreateWithSession(ctx, victim, session)
	if err == nil {
		t.Fatal("expected CreateWithSession to fail on the colliding session insert")
	}

	// The user row must NOT have been persisted — this is the atomicity pin.
	userCount := countRows(t, db, `SELECT COUNT(*) FROM users WHERE username = ?`, victim.Username)
	if userCount != 0 {
		t.Errorf("expected 0 user rows for %s after rolled-back CreateWithSession, got %d", victim.Username, userCount)
	}
}
