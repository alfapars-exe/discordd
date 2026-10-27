package repository

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/pkg"
)

// An uncommitted removal is invisible to an ordinary EXISTS snapshot. Observe
// either a completed RSVP or an actual database lock wait before committing
// the removal, so this regression does not depend on goroutine scheduling.
func TestServerEventPostgresRSVPRechecksConcurrentMembershipRemoval(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	db, _ := newPostgresTestDB(t, dsn)
	seedEventServer(t, db)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	repo := NewSQLiteServerEventRepo(db.Conn)
	event := eventFixture("Membership race", time.Now().UTC().Add(time.Hour).Format(time.RFC3339))
	if err := repo.Create(ctx, event); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var ownerPID int
	if err := tx.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&ownerPID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM server_members WHERE server_id=? AND user_id=?`, event.ServerID, dmBob); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- repo.SetInterested(ctx, event.ID, dmBob, true) }()
	var result error
	completed := false
	for !completed {
		select {
		case result = <-done:
			completed = true
		default:
			var blocked bool
			if err := db.Conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ? = ANY(pg_blocking_pids(pid)))`, ownerPID).Scan(&blocked); err != nil {
				t.Fatal(err)
			}
			if blocked {
				goto commitRemoval
			}
			select {
			case <-ctx.Done():
				t.Fatal("RSVP neither completed nor blocked behind removal")
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
commitRemoval:
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if !completed {
		result = <-done
	}
	if result != nil && !errors.Is(result, pkg.ErrConflict) {
		t.Fatalf("RSVP = %v", result)
	}
	interested, err := repo.IsInterested(ctx, event.ID, dmBob)
	if err != nil {
		t.Fatal(err)
	}
	if interested {
		t.Fatalf("RSVP survived committed membership removal (RSVP error: %v)", result)
	}
}
