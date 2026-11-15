package services

import (
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/database"
)

// Keep only immutable migrated bytes. Case data, paths and pools stay private.
type serviceFixtureFactory struct {
	once sync.Once
	data []byte
	err  error
}

var serviceFixtures serviceFixtureFactory

func newServiceFixtureDB(t *testing.T, name string) *database.DB {
	t.Helper()
	return serviceFixtures.open(t, name)
}

func (f *serviceFixtureFactory) open(t *testing.T, name string) *database.DB {
	t.Helper()
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	f.once.Do(func() { f.data, f.err = serviceFixtureSchemaBytes(t, migrations) })
	if f.err != nil {
		t.Fatalf("prepare service fixture schema: %v", f.err)
	}
	if len(f.data) == 0 {
		t.Fatal("service fixture schema initialization did not complete")
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
	return db
}

func serviceFixtureSchemaBytes(t *testing.T, migrations fs.FS) ([]byte, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "service-schema-template.db")
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
