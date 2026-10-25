package repository

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"testing"
)

// Shared repository SQL runs with both SQLite and HICHAT_TEST_POSTGRES_DSN.
func TestServerCommunityDefaultsAndRoundTrip(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES('community-owner','community-owner','unused')`); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteServerRepo(wrapForRepo(db))
	server := &models.Server{Name: "Normal", OwnerID: "community-owner", AFKTimeoutMinutes: 60}
	if err := repo.Create(ctx, server); err != nil {
		t.Fatal(err)
	}
	loaded, err := repo.GetByID(ctx, server.ID)
	if err != nil || loaded.IsCommunity {
		t.Fatal("legacy/default server not normal", err)
	}
	loaded.IsCommunity = true
	if err = repo.Update(ctx, loaded); err != nil {
		t.Fatal(err)
	}
	loaded, err = repo.GetByID(ctx, server.ID)
	if err != nil || !loaded.IsCommunity {
		t.Fatal("community classification not persisted", err)
	}
	loaded.IsCommunity = false
	if err = repo.Update(ctx, loaded); err != nil {
		t.Fatal(err)
	}
	loaded, err = repo.GetByID(ctx, server.ID)
	if err != nil || loaded.IsCommunity {
		t.Fatal("normal classification not restored", err)
	}
}
