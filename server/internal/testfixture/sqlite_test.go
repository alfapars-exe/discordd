package testfixture

import (
	"context"
	"io/fs"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/database"
)

const serviceFixtureSchemaQuery = `SELECT type || ':' || name || ':' || tbl_name || ':' || COALESCE(sql,'') FROM sqlite_schema ORDER BY type,name`
const serviceFixtureLedgerQuery = `SELECT filename FROM schema_migrations ORDER BY filename`

// Keep an independently cold production constructor as the parity reference.
func coldServiceFixtureReference(t *testing.T) *database.DB {
	t.Helper()
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.NewLegacy(filepath.Join(t.TempDir(), "cold-reference.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func serviceFixtureStrings(t *testing.T, db *database.DB, query string) []string {
	t.Helper()
	rows, err := db.Conn.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var values []string
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			t.Fatal(err)
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return values
}

func assertServiceFixtureParity(t *testing.T, cold, candidate *database.DB) {
	t.Helper()
	for _, query := range []string{serviceFixtureSchemaQuery, serviceFixtureLedgerQuery} {
		expected := serviceFixtureStrings(t, cold, query)
		actual := serviceFixtureStrings(t, candidate, query)
		if len(expected) == 0 || !reflect.DeepEqual(actual, expected) {
			t.Fatalf("schema or ledger differs from cold production database: %v", query)
		}
	}
	assertServiceFixtureConnection(t, candidate)
}

func assertServiceFixtureConnection(t *testing.T, db *database.DB) {
	t.Helper()
	var foreignKeys, busyTimeout int
	var journal string
	err := db.Conn.QueryRow(`SELECT (SELECT foreign_keys FROM pragma_foreign_keys), (SELECT timeout FROM pragma_busy_timeout), (SELECT journal_mode FROM pragma_journal_mode)`).Scan(&foreignKeys, &busyTimeout, &journal)
	if err != nil {
		t.Fatal(err)
	}
	if foreignKeys != 1 || busyTimeout != 5000 || journal != "wal" || db.Conn.Stats().MaxOpenConnections != 4 {
		t.Fatalf("wrong connection settings: fk=%d timeout=%d journal=%s pool=%d", foreignKeys, busyTimeout, journal, db.Conn.Stats().MaxOpenConnections)
	}
	if _, err := db.Conn.Exec(`INSERT INTO user_preferences(user_id,data) VALUES('missing-fixture-owner','{}')`); err == nil {
		t.Fatal("foreign key enforcement lost")
	}
}

func TestServiceFixtureSchemaAndConnectionParity(t *testing.T) {
	var factory SQLite
	cold := coldServiceFixtureReference(t)
	first, second := factory.Open(t, "first.db"), factory.Open(t, "second.db")
	if first.Conn == second.Conn || first.Conn == cold.Conn {
		t.Fatal("fixtures share a connection pool")
	}
	assertServiceFixtureParity(t, cold, first)
	assertServiceFixtureParity(t, cold, second)
}

func assertServiceFixtureUnchanged(t *testing.T, db *database.DB, ledger []string) {
	t.Helper()
	var markers, users int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM sqlite_schema WHERE name='fixture_only_marker'`).Scan(&markers); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM users WHERE id='fixture-only-user'`).Scan(&users); err != nil {
		t.Fatal(err)
	}
	if markers != 0 || users != 0 || !reflect.DeepEqual(serviceFixtureStrings(t, db, serviceFixtureLedgerQuery), ledger) {
		t.Fatal("another fixture changed rows, schema or migration ledger")
	}
	assertServiceFixtureConnection(t, db)
}

func TestServiceFixtureRowsSchemaAndLedgerStayIsolated(t *testing.T) {
	var factory SQLite
	first, second := factory.Open(t, "first.db"), factory.Open(t, "second.db")
	ledger := serviceFixtureStrings(t, second, serviceFixtureLedgerQuery)
	_, err := first.Conn.Exec(`CREATE TABLE fixture_only_marker(value TEXT); INSERT INTO users(id,username,password_hash) VALUES('fixture-only-user','fixture_only','x'); DELETE FROM schema_migrations WHERE filename=(SELECT MIN(filename) FROM schema_migrations); PRAGMA foreign_keys=OFF`)
	if err != nil {
		t.Fatal(err)
	}
	assertServiceFixtureUnchanged(t, second, ledger)
	assertServiceFixtureUnchanged(t, factory.Open(t, "later.db"), ledger)
}

func assertServiceFixtureOwnParallelRow(t *testing.T, factory *SQLite) {
	t.Helper()
	db := factory.Open(t, "parallel.db")
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('parallel-user','same_name_in_independent_fixtures','x')`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.Conn.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM users WHERE id='parallel-user'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("wrong own row count=%d err=%v", count, err)
	}
}

func TestServiceFixtureParallelCopiesStayIsolated(t *testing.T) {
	var factory SQLite
	for _, name := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			assertServiceFixtureOwnParallelRow(t, &factory)
		})
	}
}

func TestServiceFixtureInitializerCleanupPreservesLaterCopies(t *testing.T) {
	var factory SQLite
	t.Run("initializer", func(t *testing.T) { factory.Open(t, "initializer.db") })
	t.Run("after-owner-cleanup", func(t *testing.T) {
		assertServiceFixtureConnection(t, factory.Open(t, "later.db"))
	})
}
