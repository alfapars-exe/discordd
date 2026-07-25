// Real-DB characterization for the session store — the refresh-token side of
// auth. Pins that tokens are looked up by their SHA-256 hash (never stored in
// the clear), that a wrong token is ErrNotFound rather than a panic, and the
// delete-by-id / by-user / expired contracts the logout and rotation paths
// depend on.
package repository

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func newSessionRepos(t *testing.T) (db *database.DB, userRepo UserRepository, sessionRepo SessionRepository) {
	t.Helper()
	d := newTestDB(t)
	return d, NewSQLiteUserRepo(wrapForRepo(d)), NewSQLiteSessionRepo(wrapForRepo(d))
}

func seedSessionUser(t *testing.T, userRepo UserRepository, name string) string {
	t.Helper()
	u := &models.User{Username: name, PasswordHash: "h", Status: models.UserStatusOnline, Language: "en"}
	if err := userRepo.Create(context.Background(), u); err != nil {
		t.Fatalf("create user: %v", err)
	}
	return u.ID
}

func TestSQLiteSession_CreateAndLookupByHashedToken(t *testing.T) {
	db, userRepo, sessionRepo := newSessionRepos(t)
	ctx := context.Background()
	userID := seedSessionUser(t, userRepo, "session-owner")

	const token = "a-very-secret-refresh-token"
	session := &models.Session{UserID: userID, RefreshToken: token, ExpiresAt: time.Now().Add(time.Hour)}
	if err := sessionRepo.Create(ctx, session); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !hexID16.MatchString(session.ID) {
		t.Errorf("session.ID = %q, want 16 hex chars", session.ID)
	}
	if session.CreatedAt.IsZero() {
		t.Error("CreatedAt should be populated by the best-effort read-back")
	}

	// At rest the token is only its SHA-256 hash — never the plaintext.
	var storedHash string
	if err := db.Conn.QueryRow(`SELECT refresh_token_hash FROM sessions WHERE id = ?`, session.ID).Scan(&storedHash); err != nil {
		t.Fatalf("read stored hash: %v", err)
	}
	if storedHash != hashRefreshToken(token) {
		t.Errorf("stored hash = %q, want SHA-256 of the token", storedHash)
	}
	if storedHash == token {
		t.Error("the plaintext refresh token must never be stored")
	}

	// Lookup by the plaintext token hashes internally and echoes it back.
	got, err := sessionRepo.GetByRefreshToken(ctx, token)
	if err != nil {
		t.Fatalf("GetByRefreshToken: %v", err)
	}
	if got.ID != session.ID || got.UserID != userID {
		t.Errorf("got session %+v, want id=%s user=%s", got, session.ID, userID)
	}
	if got.RefreshToken != token {
		t.Errorf("RefreshToken echoed back = %q, want %q", got.RefreshToken, token)
	}
}

func TestSQLiteSession_GetByRefreshToken_NotFound(t *testing.T) {
	_, userRepo, sessionRepo := newSessionRepos(t)
	ctx := context.Background()
	userID := seedSessionUser(t, userRepo, "nf-owner")
	_ = sessionRepo.Create(ctx, &models.Session{UserID: userID, RefreshToken: "real", ExpiresAt: time.Now().Add(time.Hour)})

	_, err := sessionRepo.GetByRefreshToken(ctx, "not-the-real-token")
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("err = %v, want pkg.ErrNotFound", err)
	}
}

func TestSQLiteSession_Deletes(t *testing.T) {
	db, userRepo, sessionRepo := newSessionRepos(t)
	ctx := context.Background()
	userID := seedSessionUser(t, userRepo, "del-owner")

	mk := func(token string, exp time.Time) *models.Session {
		s := &models.Session{UserID: userID, RefreshToken: token, ExpiresAt: exp}
		if err := sessionRepo.Create(ctx, s); err != nil {
			t.Fatalf("create session %s: %v", token, err)
		}
		return s
	}

	// DeleteByID removes exactly one.
	s1 := mk("t1", time.Now().Add(time.Hour))
	mk("t2", time.Now().Add(time.Hour))
	if err := sessionRepo.DeleteByID(ctx, s1.ID); err != nil {
		t.Fatalf("DeleteByID: %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, userID); n != 1 {
		t.Errorf("after DeleteByID: %d sessions, want 1", n)
	}

	// DeleteByUserID clears every session for the user.
	mk("t3", time.Now().Add(time.Hour))
	if err := sessionRepo.DeleteByUserID(ctx, userID); err != nil {
		t.Fatalf("DeleteByUserID: %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, userID); n != 0 {
		t.Errorf("after DeleteByUserID: %d sessions, want 0", n)
	}
}

func TestSQLiteSession_DeleteExpired(t *testing.T) {
	db, userRepo, sessionRepo := newSessionRepos(t)
	ctx := context.Background()
	userID := seedSessionUser(t, userRepo, "exp-owner")

	if err := sessionRepo.Create(ctx, &models.Session{UserID: userID, RefreshToken: "live", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatalf("create live: %v", err)
	}
	if err := sessionRepo.Create(ctx, &models.Session{UserID: userID, RefreshToken: "stale", ExpiresAt: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatalf("create stale: %v", err)
	}

	if err := sessionRepo.DeleteExpired(ctx); err != nil {
		t.Fatalf("DeleteExpired: %v", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, userID); n != 1 {
		t.Errorf("after DeleteExpired: %d sessions, want 1 (only the live one)", n)
	}
	if _, err := sessionRepo.GetByRefreshToken(ctx, "live"); err != nil {
		t.Errorf("the live session must survive DeleteExpired: %v", err)
	}
}
