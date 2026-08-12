// ServerMembershipTxRunner atomicity tests against a real local SQLite
// database — the proof that a failure between AddMember and AssignToUser
// leaves no half-joined member (a server_members row with zero roles)
// behind. Mirrors message_tx_test.go's TestMessageTxRunner_
// CommitsWholeWriteSet / _RollsBackOnError shape.
//
// The DB harness (newTestDB, countRows, execSeed) lives in testdb_test.go
// and is shared with the other repository tests.
package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/database"
)

func serverMembershipTxTestSeed(t *testing.T, db *database.DB) (serverID, userID, roleID string) {
	t.Helper()
	execSeed(t, db, []seedStmt{
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, []any{"smtx-user-1", "smtxuser1"}},
		{`INSERT INTO servers (id, name, owner_id) VALUES (?, ?, ?)`, []any{"smtx-server-1", "smtx server", "smtx-user-1"}},
		{`INSERT INTO roles (id, server_id, name) VALUES (?, ?, ?)`, []any{"smtx-role-1", "smtx-server-1", "member"}},
	})
	return "smtx-server-1", "smtx-user-1", "smtx-role-1"
}

func TestServerMembershipTxRunner_CommitsWholeWriteSet(t *testing.T) {
	db := newTestDB(t)
	serverID, userID, roleID := serverMembershipTxTestSeed(t, db)
	runner := NewServerMembershipTxRunner(db.Conn)
	ctx := context.Background()

	err := runner.InTx(ctx, func(r *ServerMembershipTxRepos) error {
		if err := r.Server.AddMember(ctx, serverID, userID); err != nil {
			return err
		}
		return r.Role.AssignToUser(ctx, userID, roleID, serverID)
	})
	if err != nil {
		t.Fatalf("InTx: %v", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM server_members WHERE server_id = ? AND user_id = ?`, serverID, userID); n != 1 {
		t.Errorf("server_members = %d, want 1", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM user_roles WHERE user_id = ? AND role_id = ?`, userID, roleID); n != 1 {
		t.Errorf("user_roles = %d, want 1", n)
	}
}

// TestServerMembershipTxRunner_RollsBackOnError — the atomicity proof
// (P1.12): when the role-assignment step fails, the already-inserted
// server_members row must vanish with the rollback rather than surviving
// as a member with zero roles (often zero effective permissions).
func TestServerMembershipTxRunner_RollsBackOnError(t *testing.T) {
	db := newTestDB(t)
	serverID, userID, _ := serverMembershipTxTestSeed(t, db)
	runner := NewServerMembershipTxRunner(db.Conn)
	ctx := context.Background()

	sentinel := errors.New("role assignment exploded")
	err := runner.InTx(ctx, func(r *ServerMembershipTxRepos) error {
		if err := r.Server.AddMember(ctx, serverID, userID); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("InTx error = %v, want sentinel", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM server_members WHERE server_id = ? AND user_id = ?`, serverID, userID); n != 0 {
		t.Errorf("server_members = %d after rollback, want 0 (member with no role assignment!)", n)
	}
}
