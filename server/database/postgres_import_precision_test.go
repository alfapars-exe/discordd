package database

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

// Real source timestamps contain nanoseconds. pgx encodes timestamptz at
// microsecond precision; hashing must compare the exact values sent to PG.
func TestImportTimestampPrecision(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE sample (value TIMESTAMP); INSERT INTO sample VALUES ('2026-08-13T06:23:00.885940413Z')`); err != nil {
		t.Fatal(err)
	}
	rows, err := db.QueryContext(context.Background(), `SELECT value FROM sample`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if !rows.Next() {
		t.Fatal("missing fixture")
	}
	values, err := importRead(rows, []importColumn{{"value", "timestamp with time zone"}})
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 8, 13, 6, 23, 0, 885940000, time.UTC)
	if got, ok := values[0].(time.Time); !ok || !got.Equal(want) {
		t.Fatalf("timestamp normalization: got %v", values[0])
	}
	if importRowHash(values) != importRowHash([]any{want}) {
		t.Fatal("PG precision hash mismatch")
	}
}
