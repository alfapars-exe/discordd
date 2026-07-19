package database

import (
	"context"
	"database/sql"
	"log"
	"strings"
	"time"
)

// Retry-on-stale-stream for remote libSQL/Turso.
//
// Each pooled *sql.Conn maps to a Hrana stream on the Turso side. Turso can
// drop a stream while database/sql still believes the connection is healthy,
// and the driver reports that as an ordinary error rather than
// driver.ErrBadConn — so database/sql's own bad-connection retry never
// engages and the error surfaces to the caller as a 500.
//
// Observed in production 2026-07-19, registration path:
//
//	failed to prepare query
//	  INSERT INTO sessions (...) RETURNING id, created_at
//	error code = 3: Error preparing statement: Hrana: `api error:
//	  `status=404 Not Found, body={"error":"stream not found: 010c4a78:3f62e03"}``
//
// Registration was the visible casualty because it is the only path that
// issues two consecutive INSERT..RETURNING statements outside a transaction:
// the users row committed, the sessions insert then hit a dead stream, and
// the caller got a 500 for an account that had in fact been created. Paths
// that batch their writes into one transaction (server creation issues six
// in a row) were unaffected, because a transaction pins one connection and
// Hrana holds that stream open for its duration.
//
// The existing ConnMaxIdleTime=5s mitigation in New() reduces the window but
// cannot close it — the stream can die while the connection is in use, not
// merely while it sits idle.
//
// Local SQLite never produces this error, so the wrapper is inert there.

// maxPrepareRetries is the number of EXTRA attempts after the first failure.
// Two is enough to walk past a small pool of stale connections without
// turning a genuinely unreachable database into a long stall — the caller is
// an HTTP request with a user waiting on it.
const maxPrepareRetries = 2

// retryBackoff spaces attempts so a fresh connection can be established
// rather than immediately drawing the same dead one back out of the pool.
const retryBackoff = 50 * time.Millisecond

// IsRetriablePrepareFailure reports whether err is a lost-stream failure
// raised while PREPARING a statement.
//
// The prepare-stage requirement is the safety property, not a detail: a
// statement that failed to prepare provably never executed, so re-running it
// cannot duplicate an insert or double-apply an update. A lost stream
// detected at execute time carries no such guarantee — the write may have
// landed before the response was lost — so it is deliberately NOT retried
// here, even though the underlying cause is identical.
func IsRetriablePrepareFailure(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "stream not found") &&
		strings.Contains(msg, "Error preparing statement")
}

// retryingQuerier wraps the shared *sql.DB so every repository inherits the
// retry without knowing about it. It intentionally implements TxQuerier and
// nothing more: statements issued inside an explicit transaction must NOT be
// retried, because a dead stream aborts the whole transaction and replaying
// one statement of it would apply that statement outside the intended atomic
// unit. WithTx callers therefore keep passing the raw *sql.Tx.
type retryingQuerier struct {
	db TxQuerier
}

// NewRetryingQuerier returns db wrapped so that statements which fail to
// prepare against a dead Hrana stream are retried on a fresh connection.
//
// Takes TxQuerier rather than *sql.DB so the retry loop can be exercised
// against a stub — the production failure cannot be provoked from a test,
// since no local driver emits a Hrana error.
func NewRetryingQuerier(db TxQuerier) TxQuerier {
	return &retryingQuerier{db: db}
}

// retry runs attempt until it stops failing with a stale-stream prepare
// error, up to maxPrepareRetries extra tries.
func retry(ctx context.Context, label string, attempt func() error) error {
	err := attempt()
	for i := 0; err != nil && IsRetriablePrepareFailure(err) && i < maxPrepareRetries; i++ {
		log.Printf("[database] stale stream on %s (attempt %d/%d), retrying: %v",
			label, i+1, maxPrepareRetries, err)
		select {
		case <-ctx.Done():
			return err // surface the original DB error, not the context error
		case <-time.After(retryBackoff):
		}
		err = attempt()
	}
	return err
}

func (r *retryingQuerier) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	var res sql.Result
	err := retry(ctx, "Exec", func() error {
		var e error
		res, e = r.db.ExecContext(ctx, query, args...)
		return e
	})
	return res, err
}

func (r *retryingQuerier) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	var rows *sql.Rows
	err := retry(ctx, "Query", func() error {
		var e error
		rows, e = r.db.QueryContext(ctx, query, args...)
		return e
	})
	return rows, err
}

// QueryRowContext is the path that matters most here: every
// INSERT..RETURNING in the repositories goes through it, including the
// sessions insert that failed in production.
//
// *sql.Row defers its error until Scan and its fields are unexported, so a
// retried Row cannot be assembled by hand. Row.Err() (Go 1.15+) reads that
// deferred error without consuming the row, which is enough to decide on a
// retry and hand the caller a real *sql.Row either way.
func (r *retryingQuerier) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	row := r.db.QueryRowContext(ctx, query, args...)
	for i := 0; IsRetriablePrepareFailure(row.Err()) && i < maxPrepareRetries; i++ {
		log.Printf("[database] stale stream on QueryRow (attempt %d/%d), retrying: %v",
			i+1, maxPrepareRetries, row.Err())
		select {
		case <-ctx.Done():
			return row
		case <-time.After(retryBackoff):
		}
		row = r.db.QueryRowContext(ctx, query, args...)
	}
	return row
}
