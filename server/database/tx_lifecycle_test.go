package database

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
)

func TestWithTxCancelledContextDoesNotReportCompletedRollbackFailure(t *testing.T) {
	db := newRunnerTestDB(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := WithTx(ctx, db.Conn, func(tx *sql.Tx) error {
		cancel()
		// Finish the rollback deterministically; database/sql can also finish it
		// automatically once cancellation arrives. Either order is valid.
		rollback := tx.Rollback()
		if rollback != nil && !errors.Is(rollback, sql.ErrTxDone) {
			t.Fatal(rollback)
		}
		return ctx.Err()
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("original cancellation lost: %v", err)
	}
	if strings.Contains(err.Error(), "rollback also failed") {
		t.Fatalf("completed cancellation rollback reported as new failure: %v", err)
	}
}

func TestWithTxCallbackFailureRollsBackChanges(t *testing.T) {
	db := newRunnerTestDB(t)
	if _, err := db.Conn.Exec("CREATE TABLE tx_probe(value INTEGER)"); err != nil {
		t.Fatal(err)
	}
	expected := errors.New("callback failure")
	err := WithTx(context.Background(), db.Conn, func(tx *sql.Tx) error {
		if _, err := tx.Exec("INSERT INTO tx_probe VALUES(1)"); err != nil {
			return err
		}
		return expected
	})
	if !errors.Is(err, expected) {
		t.Fatalf("callback error lost: %v", err)
	}
	var count int
	if err := db.Conn.QueryRow("SELECT count(*) FROM tx_probe").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial changes survived: count=%d err=%v", count, err)
	}
}

func TestWithTxUncancelledEarlyCommitStillReportsRollbackFailure(t *testing.T) {
	db := newRunnerTestDB(t)
	expected := errors.New("callback failure")
	err := WithTx(context.Background(), db.Conn, func(tx *sql.Tx) error {
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		return expected
	})
	if !errors.Is(err, expected) || !strings.Contains(err.Error(), "rollback also failed") {
		t.Fatalf("unexpected early commit was hidden: %v", err)
	}
}
