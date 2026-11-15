package main

import (
	"testing"
)

func TestCensusFixturesKeepRowsSchemaAndMigrationLedgerIsolated(t *testing.T) {
	first, firstPath := newCensusDB(t)
	second, secondPath := newCensusDB(t)
	if firstPath == secondPath {
		t.Fatal("fixtures share database path")
	}
	var firstMigrations, secondMigrations int
	if err := first.Conn.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&firstMigrations); err != nil {
		t.Fatal(err)
	}
	if err := second.Conn.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&secondMigrations); err != nil {
		t.Fatal(err)
	}
	if firstMigrations == 0 || firstMigrations != secondMigrations {
		t.Fatalf("migration ledger=%d/%d", firstMigrations, secondMigrations)
	}
	if _, err := first.Conn.Exec("CREATE TABLE fixture_isolation_marker (value TEXT)"); err != nil {
		t.Fatal(err)
	}
	if _, err := first.Conn.Exec("INSERT INTO fixture_isolation_marker VALUES ('first only')"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := second.Conn.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='fixture_isolation_marker'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("fixture schema mutation leaked")
	}
	third, _ := newCensusDB(t)
	if err := third.Conn.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='fixture_isolation_marker'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("template bytes were mutated by earlier fixture")
	}
}
