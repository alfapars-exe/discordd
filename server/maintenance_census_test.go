// Orphan census tests.
//
// Several relationships in this schema are conventions rather than
// constraints: 018_multi_server.sql added `server_id` to channels, invites,
// categories and user_roles as plain `TEXT DEFAULT 'default'`, because SQLite
// cannot combine REFERENCES with DEFAULT in ALTER TABLE ADD COLUMN. Nothing
// enforces those relationships, so drift is possible and currently invisible.
// The census counts what has drifted; it never deletes — migration 055 shows
// orphan cleanup is a deliberate, per-table decision.
package main

import (
	"context"
	"database/sql"
	"io/fs"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/testutil"
)

// newCensusDB boots a throwaway database with the full embedded migration set
// and returns it alongside its path, so a test can also open a second,
// FK-disabled connection to the same file.
func newCensusDB(t *testing.T) (*database.DB, string) {
	t.Helper()
	migrationsFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	path := filepath.Join(t.TempDir(), "census.db")
	db, err := database.New(path, migrationsFS)
	if err != nil {
		t.Fatalf("database.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, path
}

// seedOrphans writes rows through a connection with foreign_keys OFF. Some of
// the orphans we need to simulate (user_roles -> users, attachments ->
// messages) are backed by real FKs and cannot be inserted through the normal
// connection. This also mirrors how such rows plausibly reach production: via
// a path where enforcement was not in effect.
func seedOrphans(t *testing.T, path string, stmts ...string) {
	t.Helper()
	conn, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(0)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open seed conn: %v", err)
	}
	defer func() { _ = conn.Close() }()
	for _, s := range stmts {
		if _, err := conn.Exec(s); err != nil {
			t.Fatalf("seed %q: %v", s, err)
		}
	}
}

// TestCensusOrphans_FreshDatabaseIsClean pins down the signal-to-noise
// property: a database that has only ever run migrations must report nothing.
// A census that warned on every boot of a healthy deployment would be tuned
// out within a week, defeating the point of adding it.
func TestCensusOrphans_FreshDatabaseIsClean(t *testing.T) {
	db, _ := newCensusDB(t)

	reports, err := censusOrphans(context.Background(), db.Conn)
	if err != nil {
		t.Fatalf("censusOrphans: %v", err)
	}
	if len(reports) != 0 {
		t.Fatalf("fresh database reported orphans (census would be noisy in production): %+v", reports)
	}
}

// TestCensusOrphans_DetectsSeededOrphans seeds exactly one orphan per checked
// table and asserts each is found — table by table, so a broken query for one
// table cannot hide behind a passing total.
func TestCensusOrphans_DetectsSeededOrphans(t *testing.T) {
	db, path := newCensusDB(t)

	seedOrphans(t, path,
		// user_roles: user, role and server all missing.
		`INSERT INTO user_roles (user_id, role_id, server_id)
			VALUES ('ghost-user', 'ghost-role', 'ghost-server')`,
		// channels / invites / categories: server_id points nowhere.
		`INSERT INTO channels (id, name, type, server_id)
			VALUES ('orphan-channel', 'genel', 'text', 'ghost-server')`,
		`INSERT INTO invites (code, server_id)
			VALUES ('orphan-invite', 'ghost-server')`,
		`INSERT INTO categories (id, name, server_id)
			VALUES ('orphan-category', 'Metin', 'ghost-server')`,
		// attachments: message_id points nowhere.
		`INSERT INTO attachments (id, message_id, filename, file_url)
			VALUES ('orphan-attachment', 'ghost-message', 'a.png', '/api/uploads/deadbeef_a.png')`,
	)

	reports, err := censusOrphans(context.Background(), db.Conn)
	if err != nil {
		t.Fatalf("censusOrphans: %v", err)
	}

	got := make(map[string]int64, len(reports))
	for _, r := range reports {
		got[r.table] = r.rows
	}
	for _, table := range []string{"user_roles", "channels", "invites", "categories", "attachments"} {
		if got[table] != 1 {
			t.Errorf("orphan count for %s = %d, want 1 (reports: %+v)", table, got[table], reports)
		}
	}
	if len(reports) != 5 {
		t.Errorf("expected exactly 5 affected tables, got %d: %+v", len(reports), reports)
	}
}

// TestCensusOrphans_IgnoresHealthyRows: rows whose parents exist must not be
// counted. Without this, a census that counted every row would "pass" the
// test above for entirely the wrong reason.
func TestCensusOrphans_IgnoresHealthyRows(t *testing.T) {
	db, path := newCensusDB(t)

	seedOrphans(t, path,
		`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'ada', 'x')`,
		`INSERT INTO servers (id, name, owner_id) VALUES ('s1', 'Tayfa', 'u1')`,
		`INSERT INTO roles (id, name, server_id) VALUES ('r1', 'uye', 's1')`,
		`INSERT INTO user_roles (user_id, role_id, server_id) VALUES ('u1', 'r1', 's1')`,
		`INSERT INTO channels (id, name, type, server_id) VALUES ('c1', 'genel', 'text', 's1')`,
		`INSERT INTO invites (code, server_id) VALUES ('inv1', 's1')`,
		`INSERT INTO categories (id, name, server_id) VALUES ('cat1', 'Metin', 's1')`,
		`INSERT INTO messages (id, channel_id, user_id, content) VALUES ('m1', 'c1', 'u1', 'selam')`,
		`INSERT INTO attachments (id, message_id, filename, file_url)
			VALUES ('att1', 'm1', 'a.png', '/api/uploads/cafebabe_a.png')`,
	)

	reports, err := censusOrphans(context.Background(), db.Conn)
	if err != nil {
		t.Fatalf("censusOrphans: %v", err)
	}
	if len(reports) != 0 {
		t.Fatalf("fully-linked rows were reported as orphans: %+v", reports)
	}
}

// TestCensusOrphans_CountsEachOrphanOnce: user_roles is checked against three
// parents at once (user, role, server). A row missing all three is still ONE
// orphaned row, not three.
func TestCensusOrphans_CountsEachOrphanOnce(t *testing.T) {
	db, path := newCensusDB(t)

	seedOrphans(t, path,
		`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'ada', 'x')`,
		`INSERT INTO servers (id, name, owner_id) VALUES ('s1', 'Tayfa', 'u1')`,
		`INSERT INTO roles (id, name, server_id) VALUES ('r1', 'uye', 's1')`,
		// Missing user only — role and server are fine.
		`INSERT INTO user_roles (user_id, role_id, server_id) VALUES ('ghost-user', 'r1', 's1')`,
		// Missing all three.
		`INSERT INTO user_roles (user_id, role_id, server_id) VALUES ('ghost-user-2', 'ghost-role', 'ghost-server')`,
	)

	reports, err := censusOrphans(context.Background(), db.Conn)
	if err != nil {
		t.Fatalf("censusOrphans: %v", err)
	}
	if len(reports) != 1 || reports[0].table != "user_roles" {
		t.Fatalf("expected a single user_roles report, got %+v", reports)
	}
	if reports[0].rows != 2 {
		t.Errorf("user_roles orphan count = %d, want 2 (one per orphaned row, not per broken parent)", reports[0].rows)
	}
}

// TestCensusOrphans_IsReadOnly is the explicit non-deletion guarantee.
// Deletion is out of scope: migration 055 removed orphaned user_roles rows
// only after reasoning about that one table's semantics.
func TestCensusOrphans_IsReadOnly(t *testing.T) {
	db, path := newCensusDB(t)

	seedOrphans(t, path,
		`INSERT INTO user_roles (user_id, role_id, server_id) VALUES ('ghost-user', 'ghost-role', 'ghost-server')`,
		`INSERT INTO channels (id, name, type, server_id) VALUES ('orphan-channel', 'genel', 'text', 'ghost-server')`,
	)

	if _, err := censusOrphans(context.Background(), db.Conn); err != nil {
		t.Fatalf("censusOrphans: %v", err)
	}

	for _, q := range []string{
		`SELECT COUNT(*) FROM user_roles WHERE user_id = 'ghost-user'`,
		`SELECT COUNT(*) FROM channels WHERE id = 'orphan-channel'`,
	} {
		var n int
		if err := db.Conn.QueryRow(q).Scan(&n); err != nil {
			t.Fatalf("query %q: %v", q, err)
		}
		if n != 1 {
			t.Errorf("census deleted rows; %q returned %d, want 1", q, n)
		}
	}
}

// TestCensusOrphans_ReportsQueryErrors: missing tables must surface as an
// error rather than being silently reported as "no orphans".
func TestCensusOrphans_ReportsQueryErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty.db")
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = conn.Close() }()

	if _, err := censusOrphans(context.Background(), conn); err == nil {
		t.Fatal("expected an error when the tables do not exist")
	}
}

// TestMaintenanceSweeper_RunsCensusWithDB wires the census into the real
// sweeper: with a live connection the boot sweep must still complete, and the
// orphan must survive it.
func TestMaintenanceSweeper_RunsCensusWithDB(t *testing.T) {
	db, path := newCensusDB(t)
	seedOrphans(t, path,
		`INSERT INTO channels (id, name, type, server_id) VALUES ('orphan-channel', 'genel', 'text', 'ghost-server')`,
	)

	var sessionSweeps atomic.Int32
	sessions := &testutil.MockSessionRepo{
		DeleteExpiredFn: func(context.Context) error {
			sessionSweeps.Add(1)
			return nil
		},
	}
	previews := &mockLinkPreviewRepo{}

	stop := startMaintenanceSweeper(sessions, previews, db.Conn, time.Hour)
	defer stop()

	deadline := time.Now().Add(2 * time.Second)
	for sessionSweeps.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if sessionSweeps.Load() != 1 {
		t.Fatalf("boot sweep did not run with a census-enabled sweeper (sweeps=%d)", sessionSweeps.Load())
	}

	var n int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM channels WHERE id = 'orphan-channel'`).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 1 {
		t.Errorf("sweeper deleted an orphaned channel; the census must be read-only (found %d)", n)
	}
}
