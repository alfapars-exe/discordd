package repository

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/pkg"
)

func TestPostgresOwnershipTransferWaitsForDepartingTarget(t *testing.T) {
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires PostgreSQL")
	}
	db, sessions, _ := authSessionRepoFixture(t)
	actor, _ := createLogicalSession(t, sessions, "session-user", "transfer-actor", "transfer-refresh")
	execSeed(t, db, []seedStmt{
		{q: "INSERT INTO servers(id,name,owner_id) VALUES('handoff','Handoff','session-user')"},
		{q: "INSERT INTO server_members(server_id,user_id) VALUES('handoff','session-user'),('handoff','session-other')"},
		{q: "INSERT INTO roles(id,server_id,name,is_owner) VALUES('handoff-owner','handoff','Owner',1)"},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var pid int
	if err := tx.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if err := NewSQLiteServerRepo(tx).RemoveMember(ctx, "handoff", "session-other"); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := NewSQLiteServerOwnershipRepo(db.Conn).Transfer(ctx, actor.UserID, actor.ID, "hash", "", "handoff", "session-other", time.Now().Unix())
		done <- err
	}()
	for {
		var waiting bool
		if err := db.Conn.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid)))", pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("transfer completed before membership removal committed: %v", err)
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("transfer to departed target: %v", err)
	}
}
