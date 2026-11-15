package services

import (
	"io/fs"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/database"
)

// A factory owns fixture preparation, never a shared test connection.
type serviceFixtureFactory struct{}

var serviceFixtures serviceFixtureFactory

func newServiceFixtureDB(t *testing.T, name string) *database.DB {
	t.Helper()
	return serviceFixtures.open(t, name)
}

func (*serviceFixtureFactory) open(t *testing.T, name string) *database.DB {
	t.Helper()
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.NewLegacy(filepath.Join(t.TempDir(), name), migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
