package testfixture

import (
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/database"
)

// Keep only immutable migrated bytes. Case data, paths and pools stay private.
type SQLite struct {
	once sync.Once
	data []byte
	err  error
}

func (f *SQLite) Open(t testing.TB, name string) *database.DB {
	t.Helper()
	db, _ := f.OpenWithPath(t, name)
	return db
}

func (f *SQLite) OpenWithPath(t testing.TB, name string) (*database.DB, string) {
	t.Helper()
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	f.once.Do(func() { f.data, f.err = sqliteSchemaBytes(t, migrations) })
	if f.err != nil {
		t.Fatalf("prepare SQLite fixture schema: %v", f.err)
	}
	if len(f.data) == 0 {
		t.Fatal("SQLite fixture schema initialization did not complete")
	}
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, f.data, 0600); err != nil {
		t.Fatal(err)
	}
	// Reopen through production setup, including DSN PRAGMAs and ledger checks.
	db, err := database.NewLegacy(path, migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, path
}

func sqliteSchemaBytes(t testing.TB, migrations fs.FS) ([]byte, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sqlite-schema-template.db")
	db, err := database.NewLegacy(path, migrations)
	if err != nil {
		return nil, err
	}
	// The last connection must close/checkpoint WAL before copying the main file.
	if err := db.Close(); err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}
