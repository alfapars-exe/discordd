package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
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
	ctx := context.Background()
	user := &models.User{Username: "fixture_row_isolation", PasswordHash: "fixture", Status: "offline"}
	if err := repository.NewSQLiteUserRepo(first.Conn).Create(ctx, user); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.NewSQLiteUserRepo(second.Conn).GetByUsername(ctx, user.Username); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("fixture row leaked: %v", err)
	}
	third, _ := newCensusDB(t)
	if _, err := repository.NewSQLiteUserRepo(third.Conn).GetByUsername(ctx, user.Username); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("row mutation changed template: %v", err)
	}

	if err := third.Conn.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='fixture_isolation_marker'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("template bytes were mutated by earlier fixture")
	}
}

func TestCensusFixturesConcurrentCopiesKeepUniqueRowsIndependent(t *testing.T) {
	for i := 0; i < 8; i++ {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			t.Parallel()
			db, _ := newCensusDB(t)
			repo := repository.NewSQLiteUserRepo(db.Conn)
			user := &models.User{Username: "same_name_in_independent_fixtures", PasswordHash: "fixture", Status: "offline"}
			if err := repo.Create(context.Background(), user); err != nil {
				t.Fatal(err)
			}
			got, err := repo.GetByUsername(context.Background(), user.Username)
			if err != nil || got.ID != user.ID {
				t.Fatalf("own row=%+v err=%v", got, err)
			}
		})
	}
}
