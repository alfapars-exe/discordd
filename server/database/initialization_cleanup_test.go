package database

import (
	"testing"
	"testing/fstest"
)

func TestInitializationFailureClosesOwnedPool(t *testing.T) {
	db := newRunnerTestDB(t)
	_, err := initializeSQLite(db.Conn, fstest.MapFS{
		"001_broken.sql": {Data: []byte("CREATE TABLE users(id TEXT); INSERT INTO missing_table VALUES(1);")},
	})
	if err == nil {
		t.Fatal("invalid migration was accepted")
	}
	if err := db.Conn.Ping(); err == nil {
		t.Fatal("failed initialization left the pool usable")
	}
	if db.Conn.Stats().OpenConnections != 0 {
		t.Fatal("failed initialization retained an open connection")
	}
}

func TestSuccessfulInitializationTransfersPoolOwnership(t *testing.T) {
	db := newRunnerTestDB(t)
	initialized, err := initializeSQLite(db.Conn, fstest.MapFS{
		"001_probe.sql": {Data: []byte("CREATE TABLE initialization_probe(id TEXT);")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := initialized.Conn.Exec("INSERT INTO initialization_probe VALUES('still-open')"); err != nil {
		t.Fatalf("successful initialization closed its returned pool: %v", err)
	}
}
