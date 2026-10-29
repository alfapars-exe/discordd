package database

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// AcquireBackendOwner reserves a dedicated session. It must remain checked out:
// returning a session lock to the pool would make ownership unknowable.
func AcquireBackendOwner(ctx context.Context, db *sql.DB) (*sql.Conn, error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	var acquired bool
	err = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock(7341982,30)`).Scan(&acquired)
	if err != nil || !acquired {
		conn.Close()
		return nil, fmt.Errorf("single backend ownership unavailable")
	}
	return conn, nil
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
