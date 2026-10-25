package repository

import (
	"context"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func lifecycleTokens(id string) (*models.AuthSession, *models.Session) {
	now := time.Now()
	return &models.AuthSession{ID: id, UserID: "session-user", TokenVersion: 2, ClientType: "web", CreatedAt: now.Unix(), LastActiveAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()}, &models.Session{UserID: "session-user", RefreshToken: "refresh-" + id, ExpiresAt: now.Add(time.Hour)}
}
func TestSQLiteAccountLifecycleAtomicDisableRestore(t *testing.T) {
	db, sessions, refresh := authSessionRepoFixture(t)
	r := NewSQLiteAccountLifecycleRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().Unix()
	a, old := createLogicalSession(t, sessions, "session-user", "disabling", "disable-refresh")
	b, _ := createLogicalSession(t, sessions, "session-user", "other-login", "other-refresh")
	if err := r.Disable(ctx, a.UserID, a.ID, "wrong", now); err == nil {
		t.Fatal("wrong password proof disabled account")
	}
	if err := r.Disable(ctx, a.UserID, a.ID, "hash", now); err != nil {
		t.Fatal(err)
	}
	state, err := r.Get(ctx, a.UserID)
	if err != nil || state.DisabledAt == nil || state.Version != 1 {
		t.Fatalf("disabled state %+v %v", state, err)
	}
	for _, id := range []string{a.ID, b.ID} {
		if _, err := sessions.GetActive(ctx, a.UserID, id, now); err == nil {
			t.Fatal("old sign-in active")
		}
	}
	if _, err := refresh.GetByRefreshToken(ctx, old.RefreshToken); err == nil {
		t.Fatal("old refresh active")
	}
	if err := NewSQLiteUserRepo(wrapForRepo(db)).UpdateStatus(ctx, a.UserID, models.UserStatusOnline); err == nil {
		t.Fatal("late presence callback revived account")
	}
	denied, _ := lifecycleTokens("disabled-creation")
	denied.TokenVersion = 1
	if err := sessions.Create(ctx, denied); err == nil {
		t.Fatal("new sign-in on disabled account")
	}
	var wins atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			logical, next := lifecycleTokens(fmt.Sprintf("restore-%d", i))
			if err := r.RestoreWithSession(ctx, a.UserID, state.Version, "hash", logical, next); err == nil {
				wins.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatalf("restoration winners=%d", wins.Load())
	}
	state, err = r.Get(ctx, a.UserID)
	if err != nil || state.DisabledAt != nil || state.Version != 2 {
		t.Fatalf("restored state %+v %v", state, err)
	}
	active, err := sessions.ListActive(ctx, a.UserID, now)
	if err != nil || len(active) != 1 || active[0].TokenVersion != 2 {
		t.Fatalf("active %+v %v", active, err)
	}
	if _, err := sessions.GetActive(ctx, a.UserID, a.ID, now); err == nil {
		t.Fatal("restoration revived an old sign-in")
	}
	var status string
	if err := db.Conn.QueryRow(`SELECT status FROM users WHERE id=?`, a.UserID).Scan(&status); err != nil || status != "online" {
		t.Fatalf("status %s %v", status, err)
	}
}
func TestSQLiteAccountLifecycleRollbackAndBan(t *testing.T) {
	db, sessions, _ := authSessionRepoFixture(t)
	r := NewSQLiteAccountLifecycleRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().Unix()
	a, _ := createLogicalSession(t, sessions, "session-user", "rollback-disable", "rollback-disable-refresh")
	installWriteFailure(t, db, "fail_disable", "sessions", "DELETE", "")
	if err := r.Disable(ctx, a.UserID, a.ID, "hash", now); err == nil {
		t.Fatal("failed disable reported success")
	}
	state, err := r.Get(ctx, a.UserID)
	if err != nil || state.DisabledAt != nil || state.Version != 0 {
		t.Fatal("disable partly committed", err)
	}
	if _, err := sessions.GetActive(ctx, a.UserID, a.ID, now); err != nil {
		t.Fatal("failed disable ended session", err)
	}
	dropFailureTrigger(t, db, "fail_disable", "sessions")
	if err := r.Disable(ctx, a.UserID, a.ID, "hash", now); err != nil {
		t.Fatal(err)
	}
	state, _ = r.Get(ctx, a.UserID)
	logical, next := lifecycleTokens("restore-rollback")
	installWriteFailure(t, db, "fail_restore", "sessions", "INSERT", "")
	if err := r.RestoreWithSession(ctx, a.UserID, state.Version, "hash", logical, next); err == nil {
		t.Fatal("failed restore reported success")
	}
	after, _ := r.Get(ctx, a.UserID)
	if after.DisabledAt == nil || after.Version != state.Version {
		t.Fatal("restore partly committed")
	}
	var tv int
	if err := db.Conn.QueryRow(`SELECT token_version FROM users WHERE id=?`, a.UserID).Scan(&tv); err != nil || tv != 1 {
		t.Fatalf("partial token version %d %v", tv, err)
	}
	dropFailureTrigger(t, db, "fail_restore", "sessions")
	if _, err := db.Conn.Exec(`UPDATE users SET is_platform_banned=1 WHERE id='session-user'`); err != nil {
		t.Fatal(err)
	}
	if err := r.RestoreWithSession(ctx, a.UserID, state.Version, "hash", logical, next); err == nil {
		t.Fatal("restore bypassed moderation ban")
	}
	if _, err := db.Conn.Exec(`UPDATE users SET is_platform_banned=0 WHERE id='session-user'`); err != nil {
		t.Fatal(err)
	}
	if err := r.RestoreWithSession(ctx, a.UserID, state.Version, "stale-hash", logical, next); err == nil {
		t.Fatal("stale password proof restored")
	}
	if err := r.RestoreWithSession(ctx, a.UserID, state.Version, "hash", logical, next); err != nil {
		t.Fatal("retry after rollback", err)
	}
}
