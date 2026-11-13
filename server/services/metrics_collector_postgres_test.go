package services

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/repository"
	"github.com/jackc/pgx/v5"
)

func waitForCollectorPostgresState(t *testing.T, ready func(context.Context) bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if ready(ctx) {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("collector did not reach required PostgreSQL state")
		case <-ticker.C:
		}
	}
}

func stopPostgresCollector(t *testing.T, collector MetricsCollector) {
	t.Helper()
	stopped := make(chan struct{})
	go func() { collector.Stop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("collector Stop did not cancel and finish PostgreSQL work")
	}
}

func TestPostgresMetricsCollectorCancellation(t *testing.T) {
	db := postgresServerFixture(t)
	cfg, err := pgx.ParseConfig(os.Getenv("HICHAT_TEST_POSTGRES_DSN"))
	if err != nil {
		t.Fatal("invalid collector PostgreSQL fixture configuration")
	}
	if cfg.TLSConfig == nil {
		if os.Getenv("HICHAT_TEST_POSTGRES_REQUIRE_MTLS") == "1" {
			t.Fatal("collector contract requires verified mutual TLS")
		}
		t.Log("disposable loopback PostgreSQL profile without TLS")
	} else {
		if cfg.TLSConfig.InsecureSkipVerify || len(cfg.Fallbacks) != 0 {
			t.Fatal("collector TLS profile requires server verification without fallback")
		}
		var tls, clientCertificate bool
		if err := db.QueryRow("SELECT ssl, coalesce(client_dn <> '', false) FROM pg_stat_ssl WHERE pid = pg_backend_pid()").Scan(&tls, &clientCertificate); err != nil {
			t.Fatal(err)
		}
		if !tls || !clientCertificate {
			t.Fatal("collector TLS contract requires an active mutual TLS connection")
		}
	}
	t.Run("real_repository_lock_wait", func(t *testing.T) {
		collector := NewMetricsCollector(repository.NewSQLiteLiveKitRepo(db), nil, time.Hour, 30, "", nil, nil)
		t.Cleanup(collector.Stop)
		blocker, err := db.BeginTx(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		// Release the lock before collector cleanup on any assertion failure.
		t.Cleanup(func() { _ = blocker.Rollback() })
		var pid int
		if err = blocker.QueryRow("SELECT pg_backend_pid()").Scan(&pid); err != nil {
			t.Fatal(err)
		}
		if _, err = blocker.Exec("LOCK TABLE livekit_instances IN ACCESS EXCLUSIVE MODE"); err != nil {
			t.Fatal(err)
		}
		blocked := func(ctx context.Context) bool {
			var waiting bool
			if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid)))", pid).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			return waiting
		}
		collector.Start()
		waitForCollectorPostgresState(t, blocked)
		stopPostgresCollector(t, collector)
		waitForCollectorPostgresState(t, func(ctx context.Context) bool { return !blocked(ctx) })
		// The blocker still owns its connection/lock: cancellation was not a side
		// effect of releasing it, and the collector returned its own connection.
		if inUse := db.Stats().InUse; inUse != 1 {
			t.Fatalf("connections in use=%d, want only blocker", inUse)
		}
	})
	t.Run("real_repository_pool_wait", func(t *testing.T) {
		db.SetMaxOpenConns(1)
		t.Cleanup(func() { db.SetMaxOpenConns(8) })
		collector := NewMetricsCollector(repository.NewSQLiteLiveKitRepo(db), nil, time.Hour, 30, "", nil, nil)
		t.Cleanup(collector.Stop)
		held, err := db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = held.Close() })
		baseline := db.Stats().WaitCount
		collector.Start()
		waitForCollectorPostgresState(t, func(context.Context) bool { return db.Stats().WaitCount > baseline })
		stopPostgresCollector(t, collector)
		if inUse := db.Stats().InUse; inUse != 1 {
			t.Fatalf("collector altered held connection count: %d", inUse)
		}
		var one int
		if err = held.QueryRowContext(context.Background(), "SELECT 1").Scan(&one); err != nil || one != 1 {
			t.Fatalf("held connection unusable after cancellation: value=%d err=%v", one, err)
		}
		if err = held.Close(); err != nil {
			t.Fatal(err)
		}
		if inUse := db.Stats().InUse; inUse != 0 {
			t.Fatalf("collector retained %d connections", inUse)
		}
	})
}
