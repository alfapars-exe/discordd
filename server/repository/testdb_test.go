// Shared test harness for repository tests that run against a real local
// SQLite database.
//
// Repository code is almost entirely SQL: column lists, JOIN shapes, ORDER BY
// clauses, UNIQUE constraints, ON DELETE CASCADE. A mocked database cannot
// falsify any of that — only executing the statements against the real schema
// can. So every test in this package that isn't a pure-Go helper test boots a
// throwaway DB through the SAME code path main.go uses (database.New with the
// full embedded migration set), which means the migrations themselves are
// under test on every run too.
//
// Extracted from message_tx_test.go, which was the first user.
package repository

import (
	"database/sql"
	"io/fs"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/database"

	_ "modernc.org/sqlite" // registers "sqlite" for the fk-off helper connection
)

// newTestDB boots a throwaway file-backed DB with the full embedded migration
// set so repo SQL runs against the real schema.
//
// File path (not ":memory:") because the pool can hold several connections and
// each would otherwise get its own empty in-memory database. t.TempDir cleans
// it up.
//
// Note for anything touching foreign keys: database.New turns foreign_keys ON
// for local SQLite, so FK-violating rows cannot be inserted through this
// handle. See database/maintenance_census_test.go for the second-connection
// trick if a test needs to plant an orphan row deliberately.
func newTestDB(t testing.TB) *database.DB {
	t.Helper()
	db, _ := newTestDBWithPath(t)
	return db
}

// newTestDBWithPath also returns the file path, for tests that need a second
// connection with different pragmas (see execWithoutFKs).
//
// Takes testing.TB (not *testing.T) so benchmarks can share this harness —
// every existing *testing.T caller already satisfies TB, so this is a pure
// signature widening with no behavior change.
func newTestDBWithPath(t testing.TB) (*database.DB, string) {
	t.Helper()
	// runMigrations expects the FS rooted at the migrations dir (main.go does
	// the same fs.Sub before calling database.New).
	migrationsFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	path := filepath.Join(t.TempDir(), "repo_test.db")
	db, err := database.New(path, migrationsFS)
	if err != nil {
		t.Fatalf("database.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, path
}

// wrapForRepo wraps the test DB in the SAME production retry wrapper
// (database.NewRetryingQuerier) that initRepositories puts in front of every
// repository. Tests that build a repo straight from db.Conn bypass that
// wrapper, so the RawDB/WithTx unwrap path — the exact thing that silently
// stranded CreateWithSession plus six UpdatePositions/Migrate methods when the
// wrapper first landed (see database/tx.go) — went untested. Construct
// at-risk repos through this so a repo that reverts from database.RawDB(r.db)
// to a bare db.(*sql.DB) assertion fails in the suite instead of only in prod.
func wrapForRepo(db *database.DB) database.TxQuerier {
	return database.NewRetryingQuerier(db.Conn)
}

// execWithoutFKs runs statements through a second connection with
// foreign_keys OFF, so a test can plant a row that FK enforcement would
// otherwise refuse (an orphan, a dangling reference). Same trick as
// maintenance_census_test.go, and it mirrors how such rows plausibly reach
// production: through a path where enforcement was not in effect.
func execWithoutFKs(t testing.TB, path string, stmts ...string) {
	t.Helper()
	conn, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(0)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open fk-off conn: %v", err)
	}
	defer func() { _ = conn.Close() }()
	for _, s := range stmts {
		if _, err := conn.Exec(s); err != nil {
			t.Fatalf("exec %q: %v", s, err)
		}
	}
}

// countRows runs a single-integer query (COUNT(*), a bare column, …) and
// fails the test if it errors. Used for post-condition assertions that read
// the table directly rather than through the repo under test.
func countRows(t testing.TB, db *database.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.Conn.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

// execSeed runs a list of INSERT statements, failing loudly on the first
// error so a broken fixture is reported as a fixture problem rather than
// surfacing later as a mysterious empty result set.
func execSeed(t testing.TB, db *database.DB, stmts []seedStmt) {
	t.Helper()
	for _, s := range stmts {
		if _, err := db.Conn.Exec(s.q, s.args...); err != nil {
			t.Fatalf("seed %q: %v", s.q, err)
		}
	}
}

type seedStmt struct {
	q    string
	args []any
}
