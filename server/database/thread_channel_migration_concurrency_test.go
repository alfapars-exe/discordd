package database

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestThreadMigrationSerializesConcurrentStartup(t *testing.T) {
	conn, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "startup.db")+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetMaxOpenConns(2)
	for _, statement := range []string{
		`CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY)`,
		`CREATE TABLE migration_runs(id INTEGER PRIMARY KEY)`,
	} {
		if _, err := conn.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	db := &DB{Conn: conn}
	start := make(chan struct{})
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			results <- db.applyThreadChannelTypeMigration("144_thread_channel_type.sql", `INSERT INTO migration_runs VALUES(1);`)
		}()
	}
	close(start)
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatalf("concurrent startup migration failed: %v", err)
		}
	}
	if err := db.applyThreadChannelTypeMigration("144_thread_channel_type.sql", `INSERT INTO nonexistent VALUES(1);`); err != nil {
		t.Fatalf("stale pending migration executed again: %v", err)
	}
	for _, statement := range []string{`SELECT count(*) FROM migration_runs`, `SELECT count(*) FROM schema_migrations`} {
		var count int
		if err := conn.QueryRow(statement).Scan(&count); err != nil || count != 1 {
			t.Fatalf("count=%d error=%v", count, err)
		}
	}
}
