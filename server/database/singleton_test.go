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
	_, err = WaitForBackendOwner(waitCtx, pool, 50*time.Millisecond, func(h *BackendOwnerHolder) { seen = h }, nil)
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
	next, err := WaitForBackendOwner(ctx, pool, 50*time.Millisecond, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	next.ExecContext(ctx, `SELECT pg_advisory_unlock(7341982,30)`)
	next.Close()
}

// An owner session left behind by a killed process (no idle limit, as opened by
// older binaries) must be reclaimed once stale, but a recently active one not.
func TestBackendOwnerReclaimsOrphanedSession(t *testing.T) {
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
	cfg.RuntimeParams["application_name"] = "hichat"
	pool := stdlib.OpenDB(*cfg)
	defer pool.Close()
	pool.SetMaxOpenConns(4)
	previous := staleBackendOwnerAfter
	staleBackendOwnerAfter = time.Second
	defer func() { staleBackendOwnerAfter = previous }()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	orphan, err := pool.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer orphan.Close()
	var locked bool
	if err = orphan.QueryRowContext(ctx, `SELECT pg_try_advisory_lock(7341982,30)`).Scan(&locked); err != nil || !locked {
		t.Fatalf("orphan lock: %v %v", locked, err)
	}

	freshCtx, freshCancel := context.WithTimeout(ctx, 300*time.Millisecond)
	_, err = WaitForBackendOwner(freshCtx, pool, 50*time.Millisecond, nil, func(BackendOwnerHolder) { t.Error("recently active owner was reclaimed") })
	freshCancel()
	if !errors.Is(err, ErrBackendOwnerBusy) {
		t.Fatalf("fresh owner: got %v, want ErrBackendOwnerBusy", err)
	}

	time.Sleep(1500 * time.Millisecond)
	var reclaimed *BackendOwnerHolder
	owner, err := WaitForBackendOwner(ctx, pool, 50*time.Millisecond, nil, func(h BackendOwnerHolder) { reclaimed = &h })
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	if reclaimed == nil {
		t.Fatal("orphaned owner was not reported as reclaimed")
	}
	if err = orphan.PingContext(ctx); err == nil {
		t.Fatal("orphaned owner session still alive")
	}
	owner.ExecContext(ctx, `SELECT pg_advisory_unlock(7341982,30)`)
}

func TestProductDatabaseRejectsLegacyDSNs(t *testing.T) {
	for _, dsn := range []string{"local.db", "libsql://legacy.example", ""} {
		if db, err := New(dsn, nil); err == nil {
			db.Close()
			t.Fatal("product accepted legacy database")
		}
	}
}
