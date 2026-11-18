package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// Advisory ownership is database-wide, so a schema is insufficient isolation.
func backendWatchTestPool(t *testing.T) *sql.DB {
	t.Helper()
	cfg := backendWatchPostgresConfig(t)
	var identity [16]byte
	if _, err := rand.Read(identity[:]); err != nil {
		t.Fatal(err)
	}
	name := "hichat_owner_watch_" + hex.EncodeToString(identity[:])
	quoted := pgx.Identifier{name}.Sanitize()
	// Database identifiers cannot be parameters. Follow the E2E fixture's
	// statement templates with only the generated, pgx-quoted identifier.
	createQuery := fmt.Sprintf("CREATE DATABASE %s", quoted)
	dropQuery := fmt.Sprintf("DROP DATABASE %s WITH (FORCE)", quoted)

	admin := stdlib.OpenDB(*cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := admin.ExecContext(ctx, createQuery); err != nil {
		_ = admin.Close()
		t.Fatal("cannot create isolated ownership fixture")
	}
	cfg.Database = name
	pool := stdlib.OpenDB(*cfg)
	pool.SetMaxOpenConns(4)
	t.Cleanup(func() {
		_ = pool.Close()
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		stopObservation := observeBackendFixtureStatement(cleanup, admin, dropQuery)
		defer stopObservation()
		started := time.Now()
		_, dropErr := admin.ExecContext(cleanup, dropQuery)
		elapsed := time.Since(started)
		observation := stopObservation()
		if err := dropErr; err != nil {
			// Do not print driver messages/DSNs. Preserve enough typed evidence
			// to distinguish a server SQLSTATE from a local cleanup deadline.
			var state interface{ SQLState() string }
			code := ""
			if errors.As(err, &state) {
				code = state.SQLState()
			}
			t.Errorf("cannot drop owned backend-watch fixture database: fixture=%s type=%T sqlstate=%q context=%v elapsed=%s observed=%v wait_type=%q wait_event=%q blockers=%d", name, err, code, cleanup.Err(), elapsed, observation.observed, observation.kind, observation.event, observation.blockers)
		}
		_ = admin.Close()
	})
	return pool
}

func TestBackendOwnerWatchPostgresLifecycle(t *testing.T) {
	pool := backendWatchTestPool(t)
	ownerFor := func(t *testing.T) *sql.Conn {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		owner, err := database.AcquireBackendOwner(ctx, pool)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = owner.ExecContext(context.Background(), "SELECT pg_advisory_unlock(7341982,30)")
			_ = owner.Close()
		})
		return owner
	}
	t.Run("graceful_join_retains_session_until_caller_closes", func(t *testing.T) {
		owner := ownerFor(t)
		lost := make(chan struct{})
		stop := startBackendOwnerWatch(context.Background(), func(ctx context.Context) { database.WatchBackendOwner(ctx, owner, func() { close(lost) }) })
		t.Cleanup(stop)
		stop()
		select {
		case <-lost:
			t.Fatal("normal cleanup reported ownership loss")
		default:
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var stillOwned bool
		if err := owner.QueryRowContext(ctx, "SELECT EXISTS(SELECT FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=7341982 AND objid=30 AND objsubid=2 AND granted)").Scan(&stillOwned); err != nil || !stillOwned {
			t.Fatalf("watch cleanup released caller session: owned=%v err=%v", stillOwned, err)
		}
		// Observe completion before closing either resource, as main must do.
		if _, err := owner.ExecContext(ctx, "SELECT pg_advisory_unlock(7341982,30)"); err != nil {
			t.Fatal(err)
		}
		if err := owner.Close(); err != nil {
			t.Fatal(err)
		}
		select {
		case <-lost:
			t.Fatal("closed session reached an already-joined watch")
		default:
		}
	})
	t.Run("real_lock_loss_still_calls_fail_closed_handler", func(t *testing.T) {
		owner := ownerFor(t)
		lost := make(chan struct{})
		stop := startBackendOwnerWatch(context.Background(), func(ctx context.Context) { database.WatchBackendOwner(ctx, owner, func() { close(lost) }) })
		t.Cleanup(stop)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := owner.ExecContext(ctx, "SELECT pg_advisory_unlock(7341982,30)"); err != nil {
			t.Fatal(err)
		}
		select {
		case <-lost:
		case <-ctx.Done():
			t.Fatal("genuine ownership loss did not invoke fail-closed handler")
		}
		stop()
		ownerFor(t) // A separate checked-out session can acquire the released lock.
	})
}

// Only enum-like wait metadata for this exact generated statement is retained.
// No DSN, raw error message, query text or unrelated session is logged.
// Stop joins the observer before returning an immutable snapshot.
type backendFixtureWait struct {
	observed    bool
	kind, event string
	blockers    int
}

func observeBackendFixtureStatement(parent context.Context, admin *sql.DB, statement string) func() backendFixtureWait {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	result := backendFixtureWait{}
	go func() {
		defer close(done)
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				queryCtx, stop := context.WithTimeout(ctx, 500*time.Millisecond)
				var kind, event string
				var blockers int
				err := admin.QueryRowContext(queryCtx, `SELECT COALESCE(wait_event_type,''),COALESCE(wait_event,''),cardinality(pg_blocking_pids(pid)) FROM pg_stat_activity WHERE datname=current_database() AND query=$1 AND state='active' AND pid<>pg_backend_pid()`, statement).Scan(&kind, &event, &blockers)
				stop()
				if err == nil {
					result = backendFixtureWait{observed: true, kind: kind, event: event, blockers: blockers}
				}
			}
		}
	}()
	return func() backendFixtureWait { cancel(); <-done; return result }
}

func backendWatchPostgresConfig(t *testing.T) *pgx.ConnConfig {
	t.Helper()
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires disposable loopback PostgreSQL")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid PostgreSQL fixture configuration")
	}
	if (cfg.Host != "127.0.0.1" && cfg.Host != "localhost") || (cfg.Database != "hichat_test" && cfg.Database != "hichat_e2e_control") {
		t.Fatal("requires an explicit disposable loopback control database")
	}
	return cfg
}

func TestBackendOwnerFixtureWaitObservation(t *testing.T) {
	admin := stdlib.OpenDB(*backendWatchPostgresConfig(t))
	t.Cleanup(func() { admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	const statement = "SELECT pg_sleep(1.2) /* hichat-owner-fixture-observer */"
	stop := observeBackendFixtureStatement(ctx, admin, statement)
	defer stop()
	if _, err := admin.ExecContext(ctx, statement); err != nil {
		t.Fatal("owned observation probe failed")
	}
	observation := stop()
	if !observation.observed || observation.kind == "" || observation.event == "" || observation.blockers != 0 {
		t.Fatalf("wait observation missing: observed=%v type=%q event=%q blockers=%d", observation.observed, observation.kind, observation.event, observation.blockers)
	}
	t.Logf("observed controlled wait: type=%s event=%s blockers=%d", observation.kind, observation.event, observation.blockers)
}
