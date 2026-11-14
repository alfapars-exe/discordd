package repository

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/pkg"
	"testing"
)

func TestUserIdentifierLookupCaseContract(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx, `UPDATE users SET email=? WHERE id=?`, "Alice@Example.test", dmAlice); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteUserRepo(wrapForRepo(db))
	for _, name := range []string{"alice", "ALICE", "Alice"} {
		user, err := repo.GetByUsername(ctx, name)
		if err != nil || user.ID != dmAlice {
			t.Fatalf("username lookup %q failed: %v", name, err)
		}
	}
	user, err := repo.GetByEmail(ctx, "Alice@Example.test")
	if err != nil || user.ID != dmAlice {
		t.Fatalf("stored email lookup failed: %v", err)
	}
	// Preserve existing exact email semantics; recovery must not invent a
	// different case-folding rule from registration and uniqueness constraints.
	if _, err := repo.GetByEmail(ctx, "alice@example.test"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("email case contract: %v", err)
	}
}
