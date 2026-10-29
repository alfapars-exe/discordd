package database

import (
	"context"
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
	if second, err := AcquireBackendOwner(ctx, pool); err == nil {
		second.Close()
		t.Fatal("second backend acquired ownership")
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
	next, err := AcquireBackendOwner(ctx, pool)
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
