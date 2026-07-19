package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"
)

// prodStreamError is the VERBATIM error string production logged on
// 2026-07-19 when POST /api/auth/register returned 500. Keeping the real
// text here means a driver-side wording change breaks this test rather than
// silently disabling the retry in production, where it cannot be observed.
const prodStreamError = "failed to create session: failed to prepare query \n\t\tINSERT INTO sessions (id, user_id, refresh_token_hash, refresh_token, expires_at)\n\t\tVALUES (lower(hex(randomblob(8))), ?, ?, ?, ?)\n\t\tRETURNING id, created_at\nerror code = 3: Error preparing statement: Hrana: `api error: `status=404 Not Found, body={\"error\":\"stream not found: 010c4a78:3f62e03\"}``"

func TestIsRetriablePrepareFailure_matchesTheProductionError(t *testing.T) {
	if !IsRetriablePrepareFailure(errors.New(prodStreamError)) {
		t.Fatal("the exact production error must be recognised as retriable")
	}
	// Wrapped by the repository layer, as it actually reaches callers.
	wrapped := fmt.Errorf("failed to create session: %w", errors.New(prodStreamError))
	if !IsRetriablePrepareFailure(wrapped) {
		t.Error("wrapped error must still be recognised")
	}
}

func TestIsRetriablePrepareFailure_refusesExecuteStageStreamLoss(t *testing.T) {
	// A stream lost while EXECUTING may have applied the write before the
	// response was lost. Retrying could duplicate it, so this must NOT be
	// treated as retriable even though the root cause is the same.
	executeStage := "error code = 3: Error executing statement: Hrana: `api error: " +
		"`status=404 Not Found, body={\"error\":\"stream not found: 010c4a78:3f62e03\"}``"
	if IsRetriablePrepareFailure(errors.New(executeStage)) {
		t.Fatal("execute-stage stream loss must not be retried — the write may have landed")
	}
}

func TestIsRetriablePrepareFailure_ignoresUnrelatedErrors(t *testing.T) {
	for _, msg := range []string{
		"UNIQUE constraint failed: users.username",
		"database is locked",
		"context deadline exceeded",
		"Error preparing statement: syntax error near \"SELCT\"", // prepare failure, but not a lost stream
		"stream not found",                                       // lost stream, but no prepare marker
	} {
		if IsRetriablePrepareFailure(errors.New(msg)) {
			t.Errorf("must not retry: %q", msg)
		}
	}
	if IsRetriablePrepareFailure(nil) {
		t.Error("nil error must not be retriable")
	}
}

// stubQuerier counts calls and fails the first failTimes of them with the
// supplied error.
type stubQuerier struct {
	calls     int
	failTimes int
	err       error
}

func (s *stubQuerier) next() error {
	s.calls++
	if s.calls <= s.failTimes {
		return s.err
	}
	return nil
}

func (s *stubQuerier) ExecContext(_ context.Context, _ string, _ ...any) (sql.Result, error) {
	return nil, s.next()
}
func (s *stubQuerier) QueryContext(_ context.Context, _ string, _ ...any) (*sql.Rows, error) {
	return nil, s.next()
}
func (s *stubQuerier) QueryRowContext(_ context.Context, _ string, _ ...any) *sql.Row {
	return nil
}

func TestRetryingQuerier_retriesUntilTheStatementPrepares(t *testing.T) {
	stub := &stubQuerier{failTimes: 2, err: errors.New(prodStreamError)}
	q := NewRetryingQuerier(stub)

	if _, err := q.ExecContext(context.Background(), "INSERT INTO sessions VALUES (?)", 1); err != nil {
		t.Fatalf("expected the retry to succeed, got %v", err)
	}
	if stub.calls != 3 {
		t.Errorf("calls = %d, want 3 (initial + 2 retries)", stub.calls)
	}
}

func TestRetryingQuerier_givesUpAndReturnsTheOriginalError(t *testing.T) {
	// A database that is genuinely unreachable must fail the request rather
	// than stall it — the caller is an HTTP handler with a user waiting.
	stub := &stubQuerier{failTimes: 99, err: errors.New(prodStreamError)}
	q := NewRetryingQuerier(stub)

	_, err := q.ExecContext(context.Background(), "INSERT INTO sessions VALUES (?)", 1)
	if err == nil {
		t.Fatal("expected the error to surface after retries are exhausted")
	}
	if !IsRetriablePrepareFailure(err) {
		t.Errorf("the original DB error must be preserved, got %v", err)
	}
	if stub.calls != maxPrepareRetries+1 {
		t.Errorf("calls = %d, want %d", stub.calls, maxPrepareRetries+1)
	}
}

func TestRetryingQuerier_doesNotRetryOrdinaryFailures(t *testing.T) {
	// A UNIQUE violation is a real answer, not a transport fault. Retrying
	// it would triple the work and delay a 409 the caller needs promptly.
	stub := &stubQuerier{failTimes: 99, err: errors.New("UNIQUE constraint failed: users.username")}
	q := NewRetryingQuerier(stub)

	if _, err := q.QueryContext(context.Background(), "INSERT INTO users VALUES (?)", 1); err == nil {
		t.Fatal("expected the error to surface")
	}
	if stub.calls != 1 {
		t.Errorf("calls = %d, want 1 — ordinary errors must not be retried", stub.calls)
	}
}

func TestRetryingQuerier_queryRowPassesThroughAgainstARealDatabase(t *testing.T) {
	// QueryRowContext is the INSERT..RETURNING path. Local SQLite cannot
	// produce a Hrana error, so what is pinned here is that wrapping does
	// not disturb ordinary behaviour: results still arrive, and a genuine
	// error still reaches Scan exactly once.
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`); err != nil {
		t.Fatalf("create: %v", err)
	}

	q := NewRetryingQuerier(db)

	var id int64
	var name string
	if err := q.QueryRowContext(context.Background(),
		`INSERT INTO t (name) VALUES (?) RETURNING id, name`, "hi").Scan(&id, &name); err != nil {
		t.Fatalf("RETURNING insert through the wrapper failed: %v", err)
	}
	if name != "hi" {
		t.Errorf("name = %q, want hi", name)
	}

	// The row must actually be there — a retry must not have swallowed it
	// or applied it twice.
	var count int
	if err := q.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM t`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("row count = %d, want exactly 1", count)
	}

	// A genuine error still surfaces from Scan.
	if err := q.QueryRowContext(context.Background(), `SELECT nope FROM t`).Scan(&count); err == nil {
		t.Error("expected a scan error for an invalid column")
	}
}
