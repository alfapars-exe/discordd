package database

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestPostgresNativeMigrationAllowsJSONOperator(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires local PostgreSQL")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil || (cfg.Host != "localhost" && cfg.Host != "127.0.0.1") {
		t.Fatal("local PostgreSQL configuration required")
	}
	db := PostgreSQLPool(cfg)
	defer db.Close()
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
