package database

import "testing"

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
