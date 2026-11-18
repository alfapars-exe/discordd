package database

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"os"
	"testing"
	"time"
)

func TestBackendOwnerExcludesSecondAndDetectsLoss(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires local PostgreSQL")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "localhost" && cfg.Host != "127.0.0.1" {
		t.Fatal("local database required")
	}
	pool := stdlib.OpenDB(*cfg)
	defer pool.Close()
	pool.SetMaxOpenConns(4)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	owner, err := AcquireBackendOwner(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	if second, err := AcquireBackendOwner(ctx, pool); !errors.Is(err, ErrBackendOwnerBusy) {
		if second != nil {
			second.Close()
		}
		t.Fatalf("second backend: got %v, want ErrBackendOwnerBusy", err)
	}
	var idle string
	if err = owner.QueryRowContext(ctx, `SHOW idle_session_timeout`).Scan(&idle); err != nil || idle != "30s" {
		t.Fatalf("owner idle_session_timeout = %q, %v; want 30s", idle, err)
	}
	waitCtx, waitCancel := context.WithTimeout(ctx, 300*time.Millisecond)
	var seen *BackendOwnerHolder
	_, err = WaitForBackendOwner(waitCtx, pool, 50*time.Millisecond, func(h *BackendOwnerHolder) { seen = h })
	waitCancel()
	if !errors.Is(err, ErrBackendOwnerBusy) || seen == nil || seen.PID == 0 {
		t.Fatalf("waiting second backend: err=%v holder=%+v", err, seen)
	}
	lost := make(chan struct{})
	go WatchBackendOwner(ctx, owner, func() { close(lost) })
	if _, err = owner.ExecContext(ctx, `SELECT pg_advisory_unlock(7341982,30)`); err != nil {
		t.Fatal(err)
	}
	select {
	case <-lost:
	case <-ctx.Done():
		t.Fatal("ownership loss was not detected")
	}
	next, err := WaitForBackendOwner(ctx, pool, 50*time.Millisecond, nil)
	if err != nil {
		t.Fatal(err)
	}
	next.ExecContext(ctx, `SELECT pg_advisory_unlock(7341982,30)`)
	next.Close()
}

func TestProductDatabaseRejectsLegacyDSNs(t *testing.T) {
	for _, dsn := range []string{"local.db", "libsql://legacy.example", ""} {
		if db, err := New(dsn, nil); err == nil {
			db.Close()
			t.Fatal("product accepted legacy database")
		}
	}
}
