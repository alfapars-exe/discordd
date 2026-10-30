package repository

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

func authSessionRepoFixture(t *testing.T) (*database.DB, AuthSessionRepository, SessionRepository) {
	t.Helper()
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash) VALUES('session-user','sessionuser','hash'),('session-other','sessionother','hash')`}})
	return db, NewSQLiteAuthSessionRepo(wrapForRepo(db)), NewSQLiteSessionRepo(wrapForRepo(db))
}
func createLogicalSession(t *testing.T, r AuthSessionRepository, owner, id, token string) (*models.AuthSession, *models.Session) {
	t.Helper()
	now := time.Now()
	s := &models.AuthSession{ID: id, UserID: owner, CreatedAt: now.Unix(), LastActiveAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(), ClientType: "web"}
	refresh := &models.Session{UserID: owner, RefreshToken: token, ExpiresAt: now.Add(time.Hour)}
	if err := r.CreateWithRefresh(context.Background(), s, refresh); err != nil {
		t.Fatal(err)
	}
	return s, refresh
}

func TestSQLiteAuthSessionRevokedActorAndGlobalBoundary(t *testing.T) {
	db, r, refresh := authSessionRepoFixture(t)
	ctx := context.Background()
	now := time.Now().Unix()
	a, _ := createLogicalSession(t, r, "session-user", "actor", "actor-refresh")
	b, old := createLogicalSession(t, r, "session-user", "target", "target-refresh")
	foreign, _ := createLogicalSession(t, r, "session-other", "foreign", "foreign-refresh")
	if _, err := r.Revoke(ctx, a.UserID, a.ID, now); err != nil {
		t.Fatal(err)
	}
	if ok, err := r.Revoke(ctx, b.UserID, b.ID, now, a.ID); err != nil || ok {
		t.Fatalf("revoked actor changed target: %v %v", ok, err)
	}
	if _, err := r.RevokeOthers(ctx, a.UserID, a.ID, now); err == nil {
		t.Fatal("revoked actor ended other sessions")
	}
	if _, err := r.GetActive(ctx, b.UserID, b.ID, now); err != nil {
		t.Fatal(err)
	}
	if err := r.RevokeAll(ctx, b.UserID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := r.GetActive(ctx, b.UserID, b.ID, now); err == nil {
		t.Fatal("global revocation left logical session active")
	}
	if _, err := refresh.GetByRefreshToken(ctx, old.RefreshToken); err == nil {
		t.Fatal("global revocation left refresh token active")
	}
	var version int
	if err := db.Conn.QueryRow(`SELECT token_version FROM users WHERE id=?`, b.UserID).Scan(&version); err != nil || version != 1 {
		t.Fatalf("version %d: %v", version, err)
	}
	if _, err := r.GetActive(ctx, foreign.UserID, foreign.ID, now); err != nil {
		t.Fatal("global revocation crossed account boundary", err)
	}
	if err := r.Create(ctx, b); err == nil {
		t.Fatal("old token version recreated revoked identity")
	}
}

func TestSQLiteAuthSessionGlobalRevocationRollback(t *testing.T) {
	db, r, refresh := authSessionRepoFixture(t)
	ctx := context.Background()
	s, old := createLogicalSession(t, r, "session-user", "rollback", "rollback-refresh")
	installDeleteFailure(t, db, "fail_session_delete", "sessions")
	if err := r.RevokeAll(ctx, s.UserID, time.Now().Unix()); err == nil {
		t.Fatal("write failure incorrectly reported success")
	}
	if _, err := r.GetActive(ctx, s.UserID, s.ID, time.Now().Unix()); err != nil {
		t.Fatal("partial revocation escaped rollback", err)
	}
	if _, err := refresh.GetByRefreshToken(ctx, old.RefreshToken); err != nil {
		t.Fatal("refresh disappeared on failed revocation", err)
	}
	var version int
	if err := db.Conn.QueryRow(`SELECT token_version FROM users WHERE id=?`, s.UserID).Scan(&version); err != nil || version != 0 {
		t.Fatalf("partial version change %d: %v", version, err)
	}
}

func TestSQLiteAuthSessionPasswordCommitAndResetProof(t *testing.T) {
	for _, reset := range []bool{false, true} {
		t.Run(fmt.Sprint("reset=", reset), func(t *testing.T) {
			db, r, refresh := authSessionRepoFixture(t)
			ctx := context.Background()
			now := time.Now().Unix()
			s, old := createLogicalSession(t, r, "session-user", "credential", "credential-refresh")
			if _, err := db.Conn.Exec(`INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES('session-user','reset-proof',` + fixtureRelativeTimestamp("+1 hour") + `),('session-other','other-proof',` + fixtureRelativeTimestamp("+1 hour") + `)`); err != nil {
				t.Fatal(err)
			}
			expected, proof := "hash", ""
			if reset {
				expected, proof = "", "reset-proof"
			}
			if err := r.UpdatePasswordAndRevoke(ctx, s.UserID, expected, proof, "changed", now); err != nil {
				t.Fatal(err)
			}
			var hash string
			var version, remaining int
			if err := db.Conn.QueryRow(`SELECT password_hash,token_version FROM users WHERE id=?`, s.UserID).Scan(&hash, &version); err != nil || hash != "changed" || version != 1 {
				t.Fatalf("credential %s v%d %v", hash, version, err)
			}
			if _, err := r.GetActive(ctx, s.UserID, s.ID, now); err == nil {
				t.Fatal("credential commit retained logical access")
			}
			if _, err := refresh.GetByRefreshToken(ctx, old.RefreshToken); err == nil {
				t.Fatal("credential commit retained refresh")
			}
			if err := db.Conn.QueryRow(`SELECT count(*) FROM password_reset_tokens WHERE user_id='session-user'`).Scan(&remaining); err != nil || remaining != 0 {
				t.Fatal("reset tokens not consumed", err)
			}
			if err := db.Conn.QueryRow(`SELECT count(*) FROM password_reset_tokens WHERE user_id='session-other'`).Scan(&remaining); err != nil || remaining != 1 {
				t.Fatal("foreign reset proof removed", err)
			}
			if err := r.UpdatePasswordAndRevoke(ctx, s.UserID, expected, proof, "replayed", now); err == nil {
				t.Fatal("stale password/reset proof replayed")
			}
		})
	}
}

func TestSQLiteAuthSessionPasswordFailureRollsBackProofAndCredential(t *testing.T) {
	db, r, _ := authSessionRepoFixture(t)
	ctx := context.Background()
	now := time.Now().Unix()
	s, _ := createLogicalSession(t, r, "session-user", "failed-credential", "failed-refresh")
	if _, err := db.Conn.Exec(`INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES('session-user','proof',` + fixtureRelativeTimestamp("+1 hour") + `)`); err != nil {
		t.Fatal(err)
	}
	installDeleteFailure(t, db, "fail_reset_cleanup", "password_reset_tokens")
	if err := r.UpdatePasswordAndRevoke(ctx, s.UserID, "", "proof", "bad-partial", now); err == nil {
		t.Fatal("failure reported success")
	}
	var hash string
	var version, count int
	if err := db.Conn.QueryRow(`SELECT password_hash,token_version FROM users WHERE id=?`, s.UserID).Scan(&hash, &version); err != nil || hash != "hash" || version != 0 {
		t.Fatal("password partially committed", err)
	}
	if _, err := r.GetActive(ctx, s.UserID, s.ID, now); err != nil {
		t.Fatal("session partially revoked", err)
	}
	if err := db.Conn.QueryRow(`SELECT count(*) FROM password_reset_tokens WHERE token_hash='proof'`).Scan(&count); err != nil || count != 1 {
		t.Fatal("proof consumed despite rollback", err)
	}
	dropFailureTrigger(t, db, "fail_reset_cleanup", "password_reset_tokens")
	if _, err := db.Conn.Exec(`UPDATE password_reset_tokens SET expires_at=` + fixtureRelativeTimestamp("-1 second") + ` WHERE token_hash='proof'`); err != nil {
		t.Fatal(err)
	}
	if err := r.UpdatePasswordAndRevoke(ctx, s.UserID, "", "proof", "expired", now); err == nil {
		t.Fatal("expired proof accepted")
	}
}

func TestSQLiteAuthSessionRefreshCASAndStableIdentity(t *testing.T) {
	db, r, refreshRepo := authSessionRepoFixture(t)
	ctx := context.Background()
	s, old := createLogicalSession(t, r, "session-user", "logical-a", "original-refresh")
	var winners atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			next := &models.Session{UserID: old.UserID, RefreshToken: fmt.Sprintf("new-refresh-%d", i), ExpiresAt: time.Now().Add(time.Hour)}
			ok, err := r.RotateRefresh(ctx, old, next, s, time.Now().Unix())
			if err != nil {
				t.Error(err)
			}
			if ok {
				winners.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatalf("rotation winners=%d", winners.Load())
	}
	if _, err := refreshRepo.GetByRefreshToken(ctx, old.RefreshToken); err == nil {
		t.Fatal("consumed refresh remains valid")
	}
	var count int
	if err := db.Conn.QueryRow(`SELECT count(*) FROM sessions WHERE auth_session_id=?`, s.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("refresh rows=%d err=%v", count, err)
	}
	active, err := r.GetActive(ctx, "session-user", s.ID, time.Now().Unix())
	if err != nil || active.ID != s.ID || active.CreatedAt != s.CreatedAt {
		t.Fatal("rotation replaced sign-in identity")
	}
}

func TestSQLiteAuthSessionTombstoneAndVersionRejectRefresh(t *testing.T) {
	for _, mode := range []string{"revoked", "version"} {
		t.Run(mode, func(t *testing.T) {
			db, r, _ := authSessionRepoFixture(t)
			ctx := context.Background()
			s, old := createLogicalSession(t, r, "session-user", "logical-a", "old-refresh")
			if mode == "revoked" {
				_, _ = r.Revoke(ctx, old.UserID, s.ID, time.Now().Unix())
			} else {
				_, _ = db.Conn.Exec(`UPDATE users SET token_version=token_version+1 WHERE id=?`, old.UserID)
			}
			next := &models.Session{UserID: old.UserID, RefreshToken: "must-not-be-issued", ExpiresAt: time.Now().Add(time.Hour)}
			if ok, err := r.RotateRefresh(ctx, old, next, s, time.Now().Unix()); err != nil || ok {
				t.Fatalf("resurrection: %v %v", ok, err)
			}
			if _, err := r.GetActive(ctx, old.UserID, s.ID, time.Now().Unix()); err == nil {
				t.Fatal("ended session remains active")
			}
		})
	}
}

func TestSQLiteAuthSessionRotationRollbackAndOwnerIsolation(t *testing.T) {
	_, r, refreshRepo := authSessionRepoFixture(t)
	ctx := context.Background()
	s, old := createLogicalSession(t, r, "session-user", "logical-a", "old-refresh")
	_, _ = createLogicalSession(t, r, "session-other", "logical-b", "colliding-refresh")
	next := &models.Session{UserID: old.UserID, RefreshToken: "colliding-refresh", ExpiresAt: time.Now().Add(time.Hour)}
	if _, err := r.RotateRefresh(ctx, old, next, s, time.Now().Unix()); err == nil {
		t.Fatal("expected unique constraint failure")
	}
	if _, err := refreshRepo.GetByRefreshToken(ctx, old.RefreshToken); err != nil {
		t.Fatalf("failed rotate destroyed old token: %v", err)
	}
	if ok, _ := r.Revoke(ctx, "session-other", s.ID, time.Now().Unix()); ok {
		t.Fatal("cross-account revoke")
	}
	if _, err := r.GetActive(ctx, "session-other", s.ID, time.Now().Unix()); err == nil {
		t.Fatal("cross-account read")
	}
	list, err := r.ListActive(ctx, "session-user", time.Now().Unix())
	if err != nil || len(list) != 1 || list[0].ID != s.ID {
		t.Fatalf("list=%+v %v", list, err)
	}
}

func TestSQLiteAuthSessionRevokeOthersAndActivity(t *testing.T) {
	db, r, _ := authSessionRepoFixture(t)
	ctx := context.Background()
	s, _ := createLogicalSession(t, r, "session-user", "current", "current-refresh")
	_, _ = createLogicalSession(t, r, "session-user", "other", "other-refresh")
	_, _ = createLogicalSession(t, r, "session-other", "foreign", "foreign-refresh")
	_, _ = db.Conn.Exec(`UPDATE auth_sessions SET last_active_at=1 WHERE id=?`, s.ID)
	active, err := r.GetActive(ctx, s.UserID, s.ID, time.Now().Unix())
	if err != nil || active.LastActiveAt <= 1 {
		t.Fatal("activity not updated")
	}
	ids, err := r.RevokeOthers(ctx, s.UserID, s.ID, time.Now().Unix())
	if err != nil || len(ids) != 1 || ids[0] != "other" {
		t.Fatalf("ids=%v %v", ids, err)
	}
	for owner, id := range map[string]string{"session-user": "current", "session-other": "foreign"} {
		if _, err := r.GetActive(ctx, owner, id, time.Now().Unix()); err != nil {
			t.Fatal("unrelated session ended")
		}
	}
}
