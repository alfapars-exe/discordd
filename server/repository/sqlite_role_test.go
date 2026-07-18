// GetRolesForUsers tests against a real local SQLite database.
//
// GetRolesForUsers is the batched replacement for the per-user
// GetByUserIDAndServer call that broadcast fan-out used to run once per online
// member. These tests pin the two properties the bulk permission resolver
// depends on: server scoping (a role held in another server must not leak) and
// exact per-user parity with the single-user query it replaces.
package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

// roleTestSeed builds a fixture with two servers so the server-scoping
// assertion has something to exclude:
//
//	srv-1: role-a (perms 1), role-b (perms 2)
//	srv-2: role-c (perms 4)
//
//	alice -> role-a + role-b (srv-1)
//	bob   -> role-b (srv-1)
//	carol -> role-c (srv-2 only)
//	dave  -> no roles at all
func roleTestSeed(t *testing.T, db *database.DB) {
	t.Helper()
	seed := []struct {
		q    string
		args []any
	}{
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, []any{"alice", "alice"}},
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, []any{"bob", "bob"}},
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, []any{"carol", "carol"}},
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, []any{"dave", "dave"}},

		{`INSERT INTO roles (id, server_id, name, position, permissions) VALUES (?, ?, ?, ?, ?)`,
			[]any{"role-a", "srv-1", "role-a", 10, 1}},
		{`INSERT INTO roles (id, server_id, name, position, permissions) VALUES (?, ?, ?, ?, ?)`,
			[]any{"role-b", "srv-1", "role-b", 5, 2}},
		{`INSERT INTO roles (id, server_id, name, position, permissions) VALUES (?, ?, ?, ?, ?)`,
			[]any{"role-c", "srv-2", "role-c", 1, 4}},

		{`INSERT INTO user_roles (user_id, role_id, server_id) VALUES (?, ?, ?)`, []any{"alice", "role-a", "srv-1"}},
		{`INSERT INTO user_roles (user_id, role_id, server_id) VALUES (?, ?, ?)`, []any{"alice", "role-b", "srv-1"}},
		{`INSERT INTO user_roles (user_id, role_id, server_id) VALUES (?, ?, ?)`, []any{"bob", "role-b", "srv-1"}},
		{`INSERT INTO user_roles (user_id, role_id, server_id) VALUES (?, ?, ?)`, []any{"carol", "role-c", "srv-2"}},
	}
	for _, s := range seed {
		if _, err := db.Conn.Exec(s.q, s.args...); err != nil {
			t.Fatalf("seed %q: %v", s.q, err)
		}
	}
}

func roleIDsOf(roles []models.Role) []string {
	out := make([]string, len(roles))
	for i, r := range roles {
		out[i] = r.ID
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestGetRolesForUsers_EmptyInput(t *testing.T) {
	db := newTxTestDB(t)
	repo := NewSQLiteRoleRepo(db.Conn)

	got, err := repo.GetRolesForUsers(context.Background(), "srv-1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty map for empty userIDs, got %d entries", len(got))
	}
}

func TestGetRolesForUsers_GroupsByUserAndScopesToServer(t *testing.T) {
	db := newTxTestDB(t)
	roleTestSeed(t, db)
	repo := NewSQLiteRoleRepo(db.Conn)

	// carol's only role lives in srv-2, so asking for srv-1 must not return it.
	// dave has no roles anywhere.
	got, err := repo.GetRolesForUsers(context.Background(), "srv-1",
		[]string{"alice", "bob", "carol", "dave"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// ORDER BY position DESC — role-a (10) before role-b (5).
	if want := []string{"role-a", "role-b"}; !equalStrings(roleIDsOf(got["alice"]), want) {
		t.Errorf("alice roles = %v, want %v", roleIDsOf(got["alice"]), want)
	}
	if want := []string{"role-b"}; !equalStrings(roleIDsOf(got["bob"]), want) {
		t.Errorf("bob roles = %v, want %v", roleIDsOf(got["bob"]), want)
	}
	if len(got["carol"]) != 0 {
		t.Errorf("carol must not leak her srv-2 role into a srv-1 query, got %v", roleIDsOf(got["carol"]))
	}
	if len(got["dave"]) != 0 {
		t.Errorf("dave has no roles, got %v", roleIDsOf(got["dave"]))
	}

	// Columns must be fully populated, not just the id.
	alice := got["alice"]
	if alice[0].ServerID != "srv-1" || alice[0].Name != "role-a" || alice[0].Permissions != models.Permission(1) {
		t.Errorf("alice role-a not fully scanned: %+v", alice[0])
	}
	if alice[1].Permissions != models.Permission(2) {
		t.Errorf("alice role-b permissions = %d, want 2", alice[1].Permissions)
	}
}

// TestGetRolesForUsers_ParityWithSingleUserQuery is the assertion that keeps
// the bulk query honest: for every user, the batched result must be identical
// (same roles, same order) to what the per-user query it replaces returns.
func TestGetRolesForUsers_ParityWithSingleUserQuery(t *testing.T) {
	db := newTxTestDB(t)
	roleTestSeed(t, db)
	repo := NewSQLiteRoleRepo(db.Conn)
	ctx := context.Background()

	users := []string{"alice", "bob", "carol", "dave"}
	for _, serverID := range []string{"srv-1", "srv-2"} {
		bulk, err := repo.GetRolesForUsers(ctx, serverID, users)
		if err != nil {
			t.Fatalf("GetRolesForUsers(%s): %v", serverID, err)
		}
		for _, userID := range users {
			single, err := repo.GetByUserIDAndServer(ctx, userID, serverID)
			if err != nil {
				t.Fatalf("GetByUserIDAndServer(%s, %s): %v", userID, serverID, err)
			}
			if !equalStrings(roleIDsOf(bulk[userID]), roleIDsOf(single)) {
				t.Errorf("server=%s user=%s: bulk %v != single %v",
					serverID, userID, roleIDsOf(bulk[userID]), roleIDsOf(single))
			}
		}
	}
}
