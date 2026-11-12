package database

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

func localDialectPostgres(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires local PostgreSQL")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil || (cfg.Host != "localhost" && cfg.Host != "127.0.0.1") {
		t.Fatal("local PostgreSQL configuration required")
	}
	db := PostgreSQLPool(cfg)
	t.Cleanup(func() { db.Close() })
	return db
}

func TestPostgresNativeMigrationAllowsJSONOperator(t *testing.T) {
	db := localDialectPostgres(t)
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := execNativeMigration(ctx, tx, `SELECT '{"key":true}'::jsonb ? 'key'`); err != nil {
		t.Fatal(err)
	}
	var value string
	if err := tx.QueryRowContext(ctx, "SELECT ?::text", "bound").Scan(&value); err != nil || value != "bound" {
		t.Fatalf("repository binding after migration: %q, %v", value, err)
	}
}

// Exercise the shared repository syntax through both database/sql drivers.
// The fixtures mirror composite-key application grants and timestamp cursors.
func TestRepositoryDialectContracts(t *testing.T) {
	t.Run("SQLite", func(t *testing.T) {
		db, err := sql.Open("sqlite", ":memory:")
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		checkRepositoryDialect(t, db)
	})
	t.Run("Postgres", func(t *testing.T) {
		checkRepositoryDialect(t, localDialectPostgres(t))
	})
}

func checkRepositoryDialect(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `CREATE TEMP TABLE dialect_grant (
		owner TEXT, target TEXT, note TEXT, updated_at TIMESTAMP,
		PRIMARY KEY(owner, target))`); err != nil {
		t.Fatal(err)
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var missing *sql.NullString
	var isNull bool
	if err := tx.QueryRowContext(ctx, "SELECT CAST(? AS TEXT) IS NULL", missing).Scan(&isNull); err != nil || !isNull {
		t.Fatalf("typed nil parameter: %t, %v", isNull, err)
	}
	const insert = `INSERT INTO dialect_grant(owner,target,note,updated_at)
		VALUES(?,?,?,?) ON CONFLICT(owner,target) DO NOTHING`
	const update = `INSERT INTO dialect_grant(owner,target,note,updated_at)
		VALUES(?,?,?,?) ON CONFLICT(owner,target) DO UPDATE
		SET note=excluded.note, updated_at=excluded.updated_at`
	const first = "2026-01-01 00:00:00.123001"
	const next = "2026-01-01 00:00:00.123002"
	for _, step := range []struct {
		query, target string
		note          any
		at            string
		changed       int64
	}{
		{insert, "a", "original", first, 1},
		{insert, "a", "ignored", next, 0},
		{insert, "b", "other", first, 1},
		{update, "a", nil, next, 1},
	} {
		result, err := tx.ExecContext(ctx, step.query, "owner", step.target, step.note, step.at)
		if err != nil {
			t.Fatal(err)
		}
		if n, err := result.RowsAffected(); err != nil || n != step.changed {
			t.Fatalf("affected rows %d, want %d: %v", n, step.changed, err)
		}
	}
	var target, literal string
	var note sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT target,note,'it''s ?3' AS "column?"
		FROM dialect_grant WHERE updated_at > ?2 AND owner=?1 AND owner=?1
		/* keep ?8 */ ORDER BY updated_at,target LIMIT 1`, "owner", first).Scan(&target, &note, &literal)
	if err != nil || target != "a" || note.Valid || literal != "it's ?3" {
		t.Fatalf("cursor row: %q %+v %q, %v", target, note, literal, err)
	}
	probe, err := tx.PrepareContext(ctx, "SELECT EXISTS(SELECT 1 FROM dialect_grant WHERE target=?)")
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Close()
	for _, key := range []string{"a", "absent"} {
		var exists int
		want := 0
		if key == "a" {
			want = 1
		}
		if err := probe.QueryRowContext(ctx, key).Scan(&exists); err != nil || exists != want {
			t.Fatalf("prepared EXISTS(%q): %d, %v", key, exists, err)
		}
	}
	if _, err := tx.ExecContext(ctx, insert, "too few"); err == nil {
		t.Fatal("accepted missing parameters")
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM dialect_grant").Scan(&count); err != nil || count != 0 {
		t.Fatalf("rows after rollback: %d, %v", count, err)
	}
}

func TestPostgresBindPreservesQuotedQuestionMarks(t *testing.T) {
	query := `SELECT '?1', "?", ?2, ?1, ?2 -- ?3
/* ?4 */ WHERE x=?`
	want := `SELECT '?1', "?", $2, $1, $2 -- ?3
/* ?4 */ WHERE x=$3`
	got, err := bindPostgres(query)
	if err != nil || got != want {
		t.Fatalf("got %q: %v", got, err)
	}
}
func TestPostgresNativeMigrationIsNotRewritten(t *testing.T) {
	query := `-- function names and bodies must remain byte-for-byte native SQL
CREATE FUNCTION hichat_json_object(VARIADIC fields TEXT[]) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT '?' || json_build_object(VARIADIC fields)::text $$;`
	got, err := postgresQuery(query)
	if err != nil || got != query {
		t.Fatalf("native SQL modified: %v", err)
	}
}

func TestBindPostgresNestedComments(t *testing.T) {
	got, err := bindPostgres("SELECT ? /* outer /* nested */ ? */ , ?")
	if err != nil || got != "SELECT $1 /* outer /* nested */ ? */ , $2" {
		t.Fatalf("unexpected translation %q, %v", got, err)
	}
	if _, err := bindPostgres("SELECT ? /* outer /* nested */"); err == nil {
		t.Fatal("accepted unterminated outer comment")
	}
}

func TestPostgresBindPositionBoundaries(t *testing.T) {
	for _, query := range []string{"SELECT ?0", "SELECT ?65536", "SELECT ?65535, ?", "SELECT ?999999999999999999999"} {
		if _, err := bindPostgres(query); err == nil {
			t.Errorf("accepted unbindable query %q", query)
		}
	}
	got, err := bindPostgres("SELECT ?65535, ?1, ?65535")
	if err != nil || got != "SELECT $65535, $1, $65535" {
		t.Fatalf("valid repeated boundary parameter: %q, %v", got, err)
	}
}

func TestPostgresNullableArgument(t *testing.T) {
	conn := &pgConn{}
	var absent *sql.NullString
	for _, tc := range []struct{ input, want any }{
		{absent, nil},
		{sql.NullBool{Valid: true, Bool: true}, int64(1)},
		{sql.NullBool{}, nil},
	} {
		arg := driver.NamedValue{Ordinal: 1, Value: tc.input}
		if err := conn.CheckNamedValue(&arg); err != nil || arg.Value != tc.want {
			t.Fatalf("argument %T: %v, %v", tc.input, arg.Value, err)
		}
	}
}

func TestBindPostgresEscapeString(t *testing.T) {
	const query = `SELECT E'it\'s ? here', ?, e'\\', ?`
	want := `SELECT E'it\'s ? here', $1, e'\\', $2`
	got, err := bindPostgres(query)
	if err != nil || got != want {
		t.Fatalf("got %q, err %v, want %q", got, err, want)
	}
}

func TestPostgresEscapeStringWithBoundValues(t *testing.T) {
	db := localDialectPostgres(t)
	var literal, first, backslash, second string
	err := db.QueryRow(`SELECT E'it\'s ? here', ?::text, e'\\', ?::text`, "one", "two").Scan(&literal, &first, &backslash, &second)
	if err != nil || literal != "it's ? here" || first != "one" || backslash != "\\" || second != "two" {
		t.Fatalf("unexpected columns: %q %q %q %q, err %v", literal, first, backslash, second, err)
	}
}

func TestBindPostgresDollarStrings(t *testing.T) {
	const query = `SELECT $$?$$, $body_2$' ? /* $$ $body_2$, ?, col$tag$, ?2`
	const want = `SELECT $$?$$, $body_2$' ? /* $$ $body_2$, $1, col$tag$, $2`
	got, err := bindPostgres(query)
	if got != want || err != nil {
		t.Fatalf("got %q, err %v, want %q", got, err, want)
	}
}
func TestPostgresDollarStringsWithBoundValues(t *testing.T) {
	db := localDialectPostgres(t)
	var plain, tagged, bound string
	err := db.QueryRow(`SELECT $$?$$, $body_2$' ? /* $$ $body_2$, ?::text`, "bound").Scan(&plain, &tagged, &bound)
	if err != nil || plain != "?" || tagged != "' ? /* $$ " || bound != "bound" {
		t.Fatalf("unexpected columns: %q %q %q, err %v", plain, tagged, bound, err)
	}
}
