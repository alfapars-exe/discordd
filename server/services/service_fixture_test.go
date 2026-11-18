package services

import (
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/internal/testfixture"
	"testing"
)

var serviceFixtures testfixture.SQLite

func newServiceFixtureDB(t *testing.T, name string) *database.DB {
	t.Helper()
	return serviceFixtures.Open(t, name)
}
