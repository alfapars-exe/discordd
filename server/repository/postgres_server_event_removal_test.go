package repository

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestServerEventPostgresRemovalCleansEarlierRSVP(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	db, _ := newPostgresTestDB(t, dsn)
	seedEventServer(t, db)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	repo := NewSQLiteServerEventRepo(db.Conn)
	event := eventFixture("reverse order audit", time.Now().UTC().Add(time.Hour).Format(time.RFC3339))
	if err := repo.Create(ctx, event); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var pid, member int
	if err := tx.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	// Hold the same membership lock as SetInterested and insert the RSVP
	// inside that transaction, leaving the commit boundary under test control.
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM server_members WHERE server_id=? AND user_id=? FOR KEY SHARE`, event.ServerID, dmBob).Scan(&member); err != nil {
		t.Fatal(err)
	}
	if err := repo.(*sqliteServerEventRepo).setInterested(ctx, tx, event.ID, dmBob); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- NewSQLiteServerRepo(db.Conn).RemoveMember(ctx, event.ServerID, dmBob) }()
	for {
		var blocked bool
		if err := db.Conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ? = ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("removal completed before RSVP commit: %v", err)
		case <-ctx.Done():
			t.Fatal("removal never waited for RSVP")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var members, rsvps int
	if err := db.Conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM server_members WHERE server_id=? AND user_id=?`, event.ServerID, dmBob).Scan(&members); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM server_event_rsvps WHERE event_id=? AND user_id=?`, event.ID, dmBob).Scan(&rsvps); err != nil {
		t.Fatal(err)
	}
	t.Logf("committed rows after RSVP then RemoveMember: members=%d rsvps=%d", members, rsvps)
	if members != 0 || rsvps != 0 {
		t.Fatalf("persisted rows: members=%d rsvps=%d", members, rsvps)
	}
}
