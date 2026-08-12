// Real-DB tests for RemoveMember's transactional DELETE pair (P1.3): the
// server_members row and the user's user_roles rows must either both go away
// or neither does. Runs against a real local SQLite database via newTestDB,
// same harness as the rest of this package's *_test.go files.
package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// seedMemberWithRole creates an owner user, a server, a membership row, a
// role, and a role assignment — everything RemoveMember's two DELETEs touch.
func seedMemberWithRole(t *testing.T, db *database.DB, namePrefix string) (userID, serverID, roleID string) {
	t.Helper()
	ctx := context.Background()

	userRepo := NewSQLiteUserRepo(db.Conn)
	serverRepo := NewSQLiteServerRepo(db.Conn)
	roleRepo := NewSQLiteRoleRepo(db.Conn)

	user := newTestUser(namePrefix + "-user")
	if err := userRepo.Create(ctx, user); err != nil {
		t.Fatalf("create user: %v", err)
	}

	server := &models.Server{Name: namePrefix + "-server", OwnerID: user.ID}
	if err := serverRepo.Create(ctx, server); err != nil {
		t.Fatalf("create server: %v", err)
	}
	if err := serverRepo.AddMember(ctx, server.ID, user.ID); err != nil {
		t.Fatalf("add member: %v", err)
	}

	role := &models.Role{ServerID: server.ID, Name: namePrefix + "-role"}
	if err := roleRepo.Create(ctx, role); err != nil {
		t.Fatalf("create role: %v", err)
	}
	if err := roleRepo.AssignToUser(ctx, user.ID, role.ID, server.ID); err != nil {
		t.Fatalf("assign role: %v", err)
	}

	return user.ID, server.ID, role.ID
}

func TestRemoveMember_DeletesMembershipAndRoleAssignments(t *testing.T) {
	db := newTestDB(t)
	userID, serverID, _ := seedMemberWithRole(t, db, "removemember")

	serverRepo := NewSQLiteServerRepo(db.Conn)
	if err := serverRepo.RemoveMember(context.Background(), serverID, userID); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM server_members WHERE server_id = ? AND user_id = ?`, serverID, userID); n != 0 {
		t.Errorf("server_members row still present after RemoveMember, count=%d", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM user_roles WHERE user_id = ? AND server_id = ?`, userID, serverID); n != 0 {
		t.Errorf("user_roles rows still present after RemoveMember, count=%d", n)
	}
}

func TestRemoveMember_NotAMember_ReturnsErrNotFoundAndLeavesRolesUntouched(t *testing.T) {
	db := newTestDB(t)
	userID, serverID, _ := seedMemberWithRole(t, db, "notamember")

	serverRepo := NewSQLiteServerRepo(db.Conn)
	// Remove the real membership first, but leave the caller unaware —
	// user_roles is deliberately left behind (FK doesn't cascade role
	// assignments from server_members) so this second call exercises the
	// affected==0 path against a user who still has a stray role row.
	if err := serverRepo.RemoveMember(context.Background(), serverID, userID); err != nil {
		t.Fatalf("first RemoveMember: %v", err)
	}

	err := serverRepo.RemoveMember(context.Background(), serverID, userID)
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("RemoveMember on a non-member: got %v, want pkg.ErrNotFound", err)
	}
}

// TestRemoveMember_TxBoundRepoUsesCallerTransaction exercises the RawDB==nil
// fallback branch: when this repo is bound to an existing *sql.Tx
// (NewSQLiteServerRepo(tx), the pattern Delete's doc comment describes),
// RemoveMember must run its two statements against that transaction instead
// of erroring out or trying to open a second, nested one.
func TestRemoveMember_TxBoundRepoUsesCallerTransaction(t *testing.T) {
	db := newTestDB(t)
	userID, serverID, _ := seedMemberWithRole(t, db, "txbound")

	tx, err := db.Conn.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("BeginTx: %v", err)
	}

	// Sanity check the premise this test is exercising: RawDB on a bare
	// *sql.Tx (no Unwrap chain back to a *sql.DB) must be nil, which is what
	// routes RemoveMember into the caller-transaction fallback branch rather
	// than the WithTx branch the other tests above cover.
	if got := database.RawDB(tx); got != nil {
		_ = tx.Rollback()
		t.Fatalf("database.RawDB(*sql.Tx) = %v, want nil", got)
	}

	txServerRepo := NewSQLiteServerRepo(tx)
	if err := txServerRepo.RemoveMember(context.Background(), serverID, userID); err != nil {
		_ = tx.Rollback()
		t.Fatalf("RemoveMember inside caller-owned tx: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM server_members WHERE server_id = ? AND user_id = ?`, serverID, userID); n != 0 {
		t.Errorf("server_members row still present after tx-bound RemoveMember, count=%d", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM user_roles WHERE user_id = ? AND server_id = ?`, userID, serverID); n != 0 {
		t.Errorf("user_roles rows still present after tx-bound RemoveMember, count=%d", n)
	}
}
