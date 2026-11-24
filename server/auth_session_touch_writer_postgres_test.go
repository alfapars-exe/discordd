package main

import (
	"context"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

// The installed session store on PostgreSQL, where it runs in production.
// The writer is held inside its statement by a row lock, so what is queued
// behind it is still queued when the writer is stopped: the validated reads
// answer without writing, stop drains the queue into the database, and a
// session revoked while its touch was waiting is not written to.
func TestInstallAuthSessionTouchWriterDrainsToPostgres(t *testing.T) {
	db := compositionPostgresDB(t)
	if !database.IsPostgres(db) {
		t.Fatal("fixture is not PostgreSQL")
	}
	repos := initRepositories(db, repository.DataExportStorageOptions{UploadDir: t.TempDir(), ArchiveDir: t.TempDir()})
	stop := installAuthSessionTouchWriter(db, repos)
	t.Cleanup(stop)
	ctx := context.Background()
	user := &models.User{Username: "pg_touch_fixture", PasswordHash: "hash", Status: models.UserStatusOnline}
	if err := repos.User.Create(ctx, user); err != nil {
		t.Fatal(err)
	}
	created := time.Now()
	const held, queued, revoked, fresh = "pg-touch-held", "pg-touch-queued", "pg-touch-revoked", "pg-touch-fresh"
	for _, id := range []string{held, queued, revoked, fresh} {
		session := &models.AuthSession{ID: id, UserID: user.ID, ClientType: "web", CreatedAt: created.Unix(), LastActiveAt: created.Unix(), ExpiresAt: created.Add(time.Hour).Unix()}
		refresh := &models.Session{UserID: user.ID, RefreshToken: id + "-refresh", ExpiresAt: created.Add(time.Hour)}
		if err := repos.AuthSession.CreateWithRefresh(ctx, session, refresh); err != nil {
			t.Fatal(err)
		}
	}
	stored := func(id string) (at int64) {
		t.Helper()
		if err := db.QueryRow(`SELECT last_active_at FROM auth_sessions WHERE id=?`, id).Scan(&at); err != nil {
			t.Fatal(err)
		}
		return at
	}
	if _, err := db.Exec(`UPDATE auth_sessions SET last_active_at=1 WHERE id<>?`, fresh); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	// A read that wrote on its own path would wait for the row held below;
	// its context turns that into a failure instead of a hung test.
	read := func(id string, want int64) {
		t.Helper()
		readCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		active, err := repos.AuthSession.GetActive(readCtx, user.ID, id, now)
		if err != nil || active.LastActiveAt != want {
			t.Fatalf("%s: read reported %+v, %v; want last_active_at=%d", id, active, err, want)
		}
		if readCtx.Err() != nil {
			t.Fatalf("%s: the read waited for the session's row", id)
		}
	}

	// Hold the first session's row: the writer's statement for it waits.
	blocker, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = blocker.Rollback() })
	var blockerPID int
	if err := blocker.QueryRow(`SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec(`UPDATE auth_sessions SET user_agent='held' WHERE id=?`, held); err != nil {
		t.Fatal(err)
	}
	read(held, now)
	deadline := time.Now().Add(5 * time.Second)
	for waiting := 0; waiting == 0; {
		if err := db.QueryRow(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND ?=ANY(pg_blocking_pids(pid)) AND query LIKE 'UPDATE auth_sessions SET last_active_at%'`, blockerPID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting == 0 && time.Now().After(deadline) {
			t.Fatal("the writer's touch never reached the database")
		}
		if waiting == 0 {
			time.Sleep(5 * time.Millisecond)
		}
	}

	// These queue behind it. A session seen within the last minute is not
	// touched at all; the others report the activity the read observed.
	read(queued, now)
	read(revoked, now)
	read(fresh, created.Unix())
	if ok, err := repos.AuthSession.Revoke(ctx, user.ID, revoked, now, queued); err != nil || !ok {
		t.Fatalf("revoke: %v %v", ok, err)
	}
	for _, id := range []string{held, queued, revoked} {
		if at := stored(id); at != 1 {
			t.Fatalf("%s was written on the read's path: last_active_at=%d", id, at)
		}
	}

	// Stop with one touch in flight and two queued, then let the writer go.
	stopped := make(chan struct{})
	go func() {
		stop()
		close(stopped)
	}()
	// Give stop the head start that makes the queued touches a drain; the
	// assertions below hold in either order.
	time.Sleep(100 * time.Millisecond)
	select {
	case <-stopped:
		t.Fatal("stop returned while a touch was still in flight")
	default:
	}
	if err := blocker.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	case <-time.After(10 * time.Second):
		t.Fatal("stop did not finish after the database answered")
	}

	if at := stored(held); at != now {
		t.Fatalf("in-flight touch: last_active_at=%d, want %d", at, now)
	}
	if at := stored(queued); at != now {
		t.Fatalf("stop left the queued touch unwritten: last_active_at=%d, want %d", at, now)
	}
	if at := stored(revoked); at != 1 {
		t.Fatalf("revoked session was touched: last_active_at=%d", at)
	}
	if at := stored(fresh); at != created.Unix() {
		t.Fatalf("recently active session was rewritten: last_active_at=%d", at)
	}
	var agent string
	if err := db.QueryRow(`SELECT user_agent FROM auth_sessions WHERE id=?`, held).Scan(&agent); err != nil || agent != "held" {
		t.Fatalf("the touch overwrote the concurrent update: user_agent=%q err=%v", agent, err)
	}

	// Once stopped, a read still reports the activity and writes nothing.
	if _, err := db.Exec(`UPDATE auth_sessions SET last_active_at=1 WHERE id=?`, queued); err != nil {
		t.Fatal(err)
	}
	read(queued, now)
	if at := stored(queued); at != 1 {
		t.Fatalf("read after stop wrote last_active_at=%d inline", at)
	}
}
