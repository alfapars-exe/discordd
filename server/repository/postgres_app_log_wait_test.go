package repository

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

// Observe the actual wait before the deadline: a timeout alone cannot tell a
// saturated connection pool from an insert waiting for a PostgreSQL table lock.
func TestPostgresAppLogWriteWaitCancellationAndRecovery(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	db, _ := newPostgresTestDB(t, dsn)
	repo := NewSQLiteAppLogRepo(wrapForRepo(db)).(*sqliteAppLogRepo)
	entry := models.AppLog{Level: models.LogLevelWarn, Category: models.LogCategoryGeneral, Message: "wait contract", Metadata: "{}"}
	t.Run("pool exhaustion", func(t *testing.T) {
		db.Conn.SetMaxOpenConns(1)
		defer db.Conn.SetMaxOpenConns(4)
		held, err := db.Conn.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		defer held.Close()
		before := db.Conn.Stats().WaitCount
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() { _, err := repo.InsertBatch(ctx, []models.AppLog{entry}); done <- err }()
		for db.Conn.Stats().WaitCount == before {
			select {
			case err := <-done:
				t.Fatalf("insert did not enter pool wait: %v", err)
			case <-time.After(5 * time.Millisecond):
			}
		}
		if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("pool wait lost deadline identity: %v", err)
		}
		if err := held.Close(); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM app_logs`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("timed out insert persisted: count=%d err=%v", count, err)
		}
	})
	t.Run("PostgreSQL lock", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		blocker, err := db.Conn.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer blocker.Rollback()
		var blockerPID int
		if err := blocker.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
			t.Fatal(err)
		}
		if _, err := blocker.ExecContext(ctx, `LOCK TABLE app_logs IN ACCESS EXCLUSIVE MODE`); err != nil {
			t.Fatal(err)
		}
		writeCtx, stopWrite := context.WithTimeout(ctx, 2*time.Second)
		defer stopWrite()
		done := make(chan error, 1)
		go func() { _, err := repo.InsertBatch(writeCtx, []models.AppLog{entry}); done <- err }()
		for {
			var waiting bool
			if err := db.Conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ? = ANY(pg_blocking_pids(pid)))`, blockerPID).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting {
				break
			}
			select {
			case err := <-done:
				t.Fatalf("insert did not enter database lock wait: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-time.After(5 * time.Millisecond):
			}
		}
		if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("database wait lost deadline identity: %v", err)
		}
		if err := blocker.Rollback(); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := db.Conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM app_logs`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("timed out insert persisted: count=%d err=%v", count, err)
		}
	})
	if written, err := repo.InsertBatch(context.Background(), []models.AppLog{entry}); err != nil || written != 1 {
		t.Fatalf("writer did not recover: written=%d err=%v", written, err)
	}
}
