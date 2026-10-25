package repository

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func newPostgresTestDB(t testing.TB, dsn string) (*database.DB, string) {
	t.Helper()
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	// This test helper must never mutate a remote production server.
	if cfg.Host != "127.0.0.1" && cfg.Host != "localhost" {
		t.Fatal("PostgreSQL acceptance database must be local")
	}
	admin := stdlib.OpenDB(*cfg)
	name := fmt.Sprintf("hichat_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE SCHEMA " + name); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg.RuntimeParams["search_path"] = name + ",public"
	db := database.PostgreSQLPool(cfg)
	db.SetMaxOpenConns(4)
	t.Cleanup(func() { db.Close(); _, _ = admin.Exec("DROP SCHEMA " + name + " CASCADE"); admin.Close() })
	if err = database.MigratePostgres(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("search_path", name+",public")
	u.RawQuery = q.Encode()
	return &database.DB{Conn: db}, u.String()
}

func postgresFixtureWithoutFKs(t testing.TB, dsn string, statements []string) {
	conn := postgresFixtureFKOffConn(t, dsn)
	for _, statement := range statements {
		if _, err := conn.Exec(statement); err != nil {
			t.Fatalf("fixture: %v", err)
		}
	}
}

// Isolated local test schema only: disables FK/trigger enforcement to exercise
// explicit repository cleanup, matching the SQLite foreign_keys=OFF fixtures.
func postgresFixtureFKOffConn(t testing.TB, dsn string) *sql.DB {
	t.Helper()
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "localhost" && cfg.Host != "127.0.0.1" {
		t.Fatal("fixture must be local")
	}
	if !strings.HasPrefix(cfg.RuntimeParams["search_path"], "hichat_test_") {
		t.Fatal("fixture requires an isolated test schema")
	}
	cfg.RuntimeParams["session_replication_role"] = "replica"
	conn := database.PostgreSQLPool(cfg)
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func installDeleteFailure(t testing.TB, db *database.DB, name, table string) {
	t.Helper()
	query := fmt.Sprintf("CREATE TRIGGER %s BEFORE DELETE ON %s BEGIN SELECT RAISE(ABORT,'fixture write failure'); END", name, table)
	if database.IsPostgres(db.Conn) {
		query = fmt.Sprintf("CREATE FUNCTION fn_%s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture write failure'; END $$; CREATE TRIGGER %s BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION fn_%s()", name, name, table, name)
	}
	if _, err := db.Conn.Exec(query); err != nil {
		t.Fatal(err)
	}
}

// Failure injection is backend-specific fixture SQL, never application SQL.
func installWriteFailure(t testing.TB, db *database.DB, name, table, operation, condition string) {
	t.Helper()
	when := ""
	if condition != "" {
		when = " WHEN " + condition
	}
	query := fmt.Sprintf("CREATE TRIGGER %s BEFORE %s ON %s%s BEGIN SELECT RAISE(ABORT,'fixture failure'); END", name, operation, table, when)
	if database.IsPostgres(db.Conn) {
		if condition != "" {
			when = " WHEN (" + condition + ")"
		}
		query = fmt.Sprintf("CREATE FUNCTION fn_%s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER %s BEFORE %s ON %s FOR EACH ROW%s EXECUTE FUNCTION fn_%s()", name, name, operation, table, when, name)
	}
	if _, err := db.Conn.Exec(query); err != nil {
		t.Fatal(err)
	}
}

func disableFixtureForeignKeys(t testing.TB, db *database.DB) {
	t.Helper()
	if !database.IsPostgres(db.Conn) {
		db.Conn.SetMaxOpenConns(1)
		db.Conn.SetConnMaxIdleTime(0)
		db.Conn.SetConnMaxLifetime(0)
		if _, err := db.Conn.Exec("PRAGMA foreign_keys=OFF"); err != nil {
			t.Fatal(err)
		}
		return
	}
	// Disable only FK triggers in this isolated schema, retaining application
	// retirement/authorization triggers and our fault-injection triggers.
	rows, err := db.Conn.Query(`SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname), quote_ident(t.tgname)
		FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
		JOIN pg_namespace n ON n.oid=c.relnamespace
		JOIN pg_constraint k ON k.oid=t.tgconstraint
		WHERE n.nspname=current_schema() AND k.contype='f'`)
	if err != nil {
		t.Fatal(err)
	}
	var statements []string
	for rows.Next() {
		var table, trigger string
		if err := rows.Scan(&table, &trigger); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		statements = append(statements, "ALTER TABLE "+table+" DISABLE TRIGGER "+trigger)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range statements {
		if _, err := db.Conn.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
}
func dropFailureTrigger(t testing.TB, db *database.DB, name, table string) {
	t.Helper()
	query := "DROP TRIGGER " + name
	if database.IsPostgres(db.Conn) {
		query += " ON " + table
	}
	if _, err := db.Conn.Exec(query); err != nil {
		t.Fatal(err)
	}
}
