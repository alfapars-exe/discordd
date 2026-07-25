package database

import (
	"database/sql"
	"testing"
)

func TestRawDB_returnsSqlDBDirectly(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	if got := RawDB(db); got != db {
		t.Errorf("RawDB(*sql.DB) = %v, want the same *sql.DB back", got)
	}
}

// TestRawDB_unwrapsRetryingQuerier pins the regression: initRepositories
// wraps the shared *sql.DB in NewRetryingQuerier before handing it to every
// repository constructor. Any repo that opens its own transaction (via a
// db.(*sql.DB) assertion) silently broke the moment that wrapping landed —
// it hit exactly this in production, registration included, because none of
// it is exercised by a test that constructs the repo directly with a raw
// *sql.DB. RawDB must see through the wrapper.
func TestRawDB_unwrapsRetryingQuerier(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	wrapped := NewRetryingQuerier(db)

	got := RawDB(wrapped)
	if got != db {
		t.Fatalf("RawDB(NewRetryingQuerier(db)) = %v, want the underlying *sql.DB %v", got, db)
	}
}

func TestRawDB_returnsNilForATransaction(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback()

	// A *sql.Tx has nothing further to unwrap — there is no raw *sql.DB to
	// hand back, and callers (e.g. sqliteUserRepo constructed inside another
	// repo's transaction) rely on getting nil here, not a panic or a bogus
	// value, so they can fall back to "no nested transaction" behavior.
	if got := RawDB(tx); got != nil {
		t.Errorf("RawDB(*sql.Tx) = %v, want nil", got)
	}
}

func TestRawDB_returnsNilForAnUnrelatedQuerier(t *testing.T) {
	stub := &stubQuerier{}
	if got := RawDB(stub); got != nil {
		t.Errorf("RawDB(unrelated TxQuerier) = %v, want nil", got)
	}
}
