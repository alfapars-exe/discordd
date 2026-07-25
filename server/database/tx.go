package database

import (
	"context"
	"database/sql"
	"fmt"
)

// TxQuerier is satisfied by both *sql.DB and *sql.Tx,
// allowing repositories to work inside or outside transactions.
type TxQuerier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// RawDB walks a chain of TxQuerier wrappers to find the underlying *sql.DB,
// or returns nil if there isn't one. A wrapper opts into the chain by
// implementing `Unwrap() TxQuerier` (mirroring the standard library's
// errors.Unwrap convention) — see retryingQuerier.Unwrap.
//
// Repositories that need to open their own transaction (WithTx) call this
// instead of asserting db.(*sql.DB) directly, so wrapping the shared
// connection in something like NewRetryingQuerier doesn't silently strand
// every repository that opens an ad-hoc transaction. It did exactly that
// once already: NewRetryingQuerier landed in initRepositories without this
// helper, and it broke registration (CreateWithSession) plus six other
// repository methods (UpdatePositions on categories/channels/roles/server
// members, MigrateServers/MigrateOneServer on livekit instances) that all
// used the same now-broken assertion — none of it caught locally, because
// every test constructs its repo directly with a *sql.DB, bypassing the
// wrapper entirely.
func RawDB(db TxQuerier) *sql.DB {
	for {
		if raw, ok := db.(*sql.DB); ok {
			return raw
		}
		unwrapper, ok := db.(interface{ Unwrap() TxQuerier })
		if !ok {
			return nil
		}
		db = unwrapper.Unwrap()
	}
}

// WithTx runs fn inside a transaction.
// Commits on success, rolls back on error or panic.
func WithTx(ctx context.Context, db *sql.DB, fn func(tx *sql.Tx) error) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}

	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}

		if err != nil {
			if rbErr := tx.Rollback(); rbErr != nil {
				err = fmt.Errorf("%w (rollback also failed: %v)", err, rbErr)
			}
			return
		}

		if commitErr := tx.Commit(); commitErr != nil {
			err = fmt.Errorf("failed to commit transaction: %w", commitErr)
		}
	}()

	err = fn(tx)
	return
}
