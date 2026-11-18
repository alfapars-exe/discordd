package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrBackendOwnerBusy means another live session currently holds the backend
// ownership lock.
var ErrBackendOwnerBusy = errors.New("single backend ownership unavailable")

// backendOwnerIdleTimeoutSQL bounds (to 30 s) how long PostgreSQL keeps an owner session
// whose process vanished without closing its socket (container killed, network
// cut). A live owner probes every second, so it is never idle this long; a
// dead one is terminated by the server and its lock released, instead of the
// lock lingering until TCP keepalive notices (hours by default).
// It is a fixed statement rather than a formatted one; singleton_test asserts
// the applied value.
const backendOwnerIdleTimeoutSQL = `SET idle_session_timeout = '30s'`

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
	if _, err = conn.ExecContext(ctx, backendOwnerIdleTimeoutSQL); err != nil {
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
func WaitForBackendOwner(ctx context.Context, db *sql.DB, retry time.Duration, onBusy func(holder *BackendOwnerHolder)) (*sql.Conn, error) {
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
