package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// ErrBackendOwnerBusy means another live session currently holds the backend
// ownership lock.
var ErrBackendOwnerBusy = errors.New("single backend ownership unavailable")

// backendOwnerIdleTimeout bounds how long PostgreSQL keeps an owner session
// whose process vanished without closing its socket (container killed, network
// cut). A live owner probes every second, so it is never idle this long; a
// dead one is terminated by the server and its lock released, instead of the
// lock lingering until TCP keepalive notices (hours by default).
const backendOwnerIdleTimeout = 30 * time.Second

// staleBackendOwnerAfter is how long a hichat owner session may sit idle before
// a booting backend treats it as orphaned. A live owner's watcher queries every
// second, so its state_change is never more than a few seconds old. This also
// recovers sessions opened by binaries that predate backendOwnerIdleTimeout,
// whose orphaned sessions would otherwise hold the lock until TCP keepalive
// (hours) — e.g. after the publisher pauses the Space and kills the container.
var staleBackendOwnerAfter = 60 * time.Second

// BackendOwnerHolder describes the session currently holding ownership, as far
// as pg_stat_activity lets this role see it.
type BackendOwnerHolder struct {
	PID             int
	ApplicationName string
	ClientAddr      string
	State           string
	BackendStart    time.Time
	StateChange     time.Time
}

// AcquireBackendOwner reserves a dedicated session. It must remain checked out:
// returning a session lock to the pool would make ownership unknowable.
func AcquireBackendOwner(ctx context.Context, db *sql.DB) (*sql.Conn, error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	var acquired bool
	err = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock(7341982,30)`).Scan(&acquired)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("backend ownership check failed: %w", err)
	}
	if !acquired {
		_ = conn.Close()
		return nil, ErrBackendOwnerBusy
	}
	// Session-scoped: only the owner session gets the idle limit.
	if _, err = conn.ExecContext(ctx, `SELECT set_config('idle_session_timeout', $1, false)`, strconv.FormatInt(backendOwnerIdleTimeout.Milliseconds(), 10)); err != nil {
		_, _ = conn.ExecContext(context.Background(), `SELECT pg_advisory_unlock(7341982,30)`)
		_ = conn.Close()
		return nil, fmt.Errorf("backend ownership idle limit failed: %w", err)
	}
	return conn, nil
}

// WaitForBackendOwner retries AcquireBackendOwner while the lock is busy, until
// ctx ends. A restarting deployment overlaps its predecessor, and a predecessor
// that died uncleanly holds the lock until the server drops its session, so a
// single attempt turns both into a crash loop. onBusy (optional) reports the
// current holder after each busy attempt; holder is nil when not visible.
// An orphaned holder (see staleBackendOwnerAfter) is terminated and reported
// through onReclaim (optional).
func WaitForBackendOwner(ctx context.Context, db *sql.DB, retry time.Duration, onBusy func(holder *BackendOwnerHolder), onReclaim func(holder BackendOwnerHolder)) (*sql.Conn, error) {
	if retry <= 0 {
		retry = 5 * time.Second
	}
	for {
		conn, err := AcquireBackendOwner(ctx, db)
		if err == nil {
			return conn, nil
		}
		if !errors.Is(err, ErrBackendOwnerBusy) {
			return nil, err
		}
		holder := lookupBackendOwnerHolder(ctx, db)
		if onBusy != nil {
			onBusy(holder)
		}
		if reclaimStaleBackendOwner(ctx, db, holder) {
			if onReclaim != nil {
				onReclaim(*holder)
			}
			continue
		}
		timer := time.NewTimer(retry)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, fmt.Errorf("%w: %s", ErrBackendOwnerBusy, describeBackendOwnerHolder(holder))
		case <-timer.C:
		}
	}
}

func lookupBackendOwnerHolder(ctx context.Context, db *sql.DB) *BackendOwnerHolder {
	probe, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var h BackendOwnerHolder
	var app, addr, state sql.NullString
	var started, changed sql.NullTime
	err := db.QueryRowContext(probe, `SELECT l.pid, a.application_name, host(a.client_addr), a.state, a.backend_start, a.state_change
		FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
		WHERE l.locktype='advisory' AND l.classid=7341982 AND l.objid=30 AND l.objsubid=2 AND l.granted
		LIMIT 1`).Scan(&h.PID, &app, &addr, &state, &started, &changed)
	if err != nil {
		return nil
	}
	h.ApplicationName, h.ClientAddr, h.State = app.String, addr.String, state.String
	h.BackendStart, h.StateChange = started.Time, changed.Time
	return &h
}

// reclaimStaleBackendOwner terminates the holder only if it is an idle hichat
// session whose last activity is older than staleBackendOwnerAfter, measured on
// the server clock. The checks are repeated inside the terminating statement so
// a holder that woke up between lookup and termination is left alone.
func reclaimStaleBackendOwner(ctx context.Context, db *sql.DB, h *BackendOwnerHolder) bool {
	if h == nil || h.PID == 0 || h.ApplicationName != "hichat" || h.State != "idle" {
		return false
	}
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var terminated bool
	err := db.QueryRowContext(probe, `SELECT COALESCE(bool_or(pg_terminate_backend(a.pid, 5000)), false)
		FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
		WHERE l.locktype='advisory' AND l.classid=7341982 AND l.objid=30 AND l.objsubid=2 AND l.granted
		  AND a.pid = $1 AND a.application_name = 'hichat' AND a.state = 'idle'
		  AND a.state_change < clock_timestamp() - make_interval(secs => $2)`,
		h.PID, staleBackendOwnerAfter.Seconds()).Scan(&terminated)
	return err == nil && terminated
}

func describeBackendOwnerHolder(h *BackendOwnerHolder) string {
	if h == nil {
		return "holder not visible"
	}
	return fmt.Sprintf("held by pid %d (application %q, client %q, state %q, since %s, last change %s)",
		h.PID, h.ApplicationName, h.ClientAddr, h.State,
		h.BackendStart.UTC().Format(time.RFC3339), h.StateChange.UTC().Format(time.RFC3339))
}

// WatchBackendOwner fails closed on connection or lock loss. The caller must
// terminate serving in onLost; a reconnect is not proof of continuing ownership.
func WatchBackendOwner(ctx context.Context, conn *sql.Conn, onLost func()) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			probe, cancel := context.WithTimeout(ctx, 2*time.Second)
			var owned bool
			err := conn.QueryRowContext(probe, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=7341982 AND objid=30 AND objsubid=2 AND granted)`).Scan(&owned)
			cancel()
			if ctx.Err() != nil {
				return
			}
			if err != nil || !owned {
				onLost()
				return
			}
		}
	}
}
