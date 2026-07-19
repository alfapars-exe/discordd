// ProbeForeignKeys tests. The probe exists because we could not otherwise
// answer "are foreign keys enforced in production?" — foreign_keys(1) is only
// set on the LOCAL SQLite DSN, the remote libSQL branch sets nothing, and
// PRAGMA statements are stripped by the migration runner because Turso
// rejects them. So the probe has to be behavioral, and these tests pin both
// verdicts down against the one driver we can actually run here.
package database

import (
	"database/sql"
	"io/fs"
	"path/filepath"
	"testing"
)

// probeSchemaStmts is the minimal slice of the real schema the probe touches:
// sessions.user_id -> users(id), copied from 001_init.sql.
var probeSchemaStmts = []string{
	`CREATE TABLE users (
		id TEXT PRIMARY KEY,
		username TEXT NOT NULL
	)`,
	`CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		refresh_token TEXT NOT NULL UNIQUE,
		expires_at DATETIME NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`,
}

// newProbeConn opens a file-backed SQLite DB with the given DSN suffix, so a
// test can choose whether FK enforcement is on. File path (not :memory:)
// because each pooled connection would otherwise see a separate database.
func newProbeConn(t *testing.T, dsnSuffix string) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "probe.db")
	conn, err := sql.Open("sqlite", path+dsnSuffix)
	if err != nil {
		t.Fatalf("open probe db: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	for _, stmt := range probeSchemaStmts {
		if _, err := conn.Exec(stmt); err != nil {
			t.Fatalf("create probe schema: %v", err)
		}
	}
	return conn
}

// TestProbeForeignKeys_DetectsEnforcement: with foreign_keys(1) — the pragma
// the local DSN actually sets — the probe insert must be refused.
func TestProbeForeignKeys_DetectsEnforcement(t *testing.T) {
	conn := newProbeConn(t, "?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")

	enforced, err := ProbeForeignKeys(conn)
	if err != nil {
		t.Fatalf("ProbeForeignKeys: %v", err)
	}
	if !enforced {
		t.Error("enforced = false with foreign_keys(1); the probe cannot detect enforcement")
	}
}

// TestProbeForeignKeys_DetectsNonEnforcement is the case that actually
// matters: the probe must NOT report enforcement when there is none. A probe
// that always answers "true" would be worse than no probe at all.
func TestProbeForeignKeys_DetectsNonEnforcement(t *testing.T) {
	conn := newProbeConn(t, "?_pragma=foreign_keys(0)&_pragma=busy_timeout(5000)")

	enforced, err := ProbeForeignKeys(conn)
	if err != nil {
		t.Fatalf("ProbeForeignKeys: %v", err)
	}
	if enforced {
		t.Error("enforced = true with foreign_keys(0); the probe reports a false positive")
	}
}

// TestProbeForeignKeys_LeavesNoRowBehind — the whole probe hinges on the
// rollback. In the FK-off case the INSERT *succeeds*, so without a rollback
// every boot would leak a junk session row referencing a nonexistent user.
func TestProbeForeignKeys_LeavesNoRowBehind(t *testing.T) {
	for _, tc := range []struct {
		name string
		dsn  string
	}{
		{"fk_on", "?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"},
		{"fk_off", "?_pragma=foreign_keys(0)&_pragma=busy_timeout(5000)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn := newProbeConn(t, tc.dsn)
			if _, err := ProbeForeignKeys(conn); err != nil {
				t.Fatalf("ProbeForeignKeys: %v", err)
			}
			var n int
			if err := conn.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&n); err != nil {
				t.Fatalf("count sessions: %v", err)
			}
			if n != 0 {
				t.Fatalf("probe left %d session row(s) behind; the transaction was not rolled back", n)
			}
		})
	}
}

// TestProbeForeignKeys_RepeatableAcrossCalls: called twice it must give the
// same answer. If the probe row ever persisted, the second call would trip
// the UNIQUE constraint on refresh_token and report an inconclusive error.
func TestProbeForeignKeys_RepeatableAcrossCalls(t *testing.T) {
	conn := newProbeConn(t, "?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")

	first, err := ProbeForeignKeys(conn)
	if err != nil {
		t.Fatalf("first probe: %v", err)
	}
	second, err := ProbeForeignKeys(conn)
	if err != nil {
		t.Fatalf("second probe: %v", err)
	}
	if first != second {
		t.Fatalf("probe is not repeatable: first=%v second=%v", first, second)
	}
}

// TestProbeForeignKeys_ReportsErrorOnMissingSchema: an unexpected failure
// (no sessions table) must surface as an error, never as a confident "false".
// Reporting "FKs are off" because the query blew up would be a false alarm.
func TestProbeForeignKeys_ReportsErrorOnMissingSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty.db")
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = conn.Close() }()

	if _, err := ProbeForeignKeys(conn); err == nil {
		t.Fatal("expected an error probing a database with no sessions table")
	}
}

// TestProbeForeignKeys_AgainstRealSchema is the end-to-end check: the real
// migration set opened through database.New (which sets foreign_keys(1))
// must report enforcement. If someone drops that pragma from the DSN, or
// rebuilds `sessions` without its FK, this test fails.
func TestProbeForeignKeys_AgainstRealSchema(t *testing.T) {
	migrationsFS, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	db, err := New(filepath.Join(t.TempDir(), "real.db"), migrationsFS)
	if err != nil {
		t.Fatalf("database.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	enforced, err := ProbeForeignKeys(db.Conn)
	if err != nil {
		t.Fatalf("ProbeForeignKeys on the real schema: %v", err)
	}
	if !enforced {
		t.Error("foreign keys are NOT enforced on a local database opened via database.New")
	}
}

// TestProbeForeignKeys_NilConn guards the main.go call path: a nil handle
// must produce an error rather than panicking during boot.
func TestProbeForeignKeys_NilConn(t *testing.T) {
	if _, err := ProbeForeignKeys(nil); err == nil {
		t.Fatal("expected an error for a nil connection")
	}
}
