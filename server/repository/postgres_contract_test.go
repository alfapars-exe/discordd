package repository

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestPostgresRetirementBlocksWaitingPersonalWrite(t *testing.T) {
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires local PostgreSQL")
	}
	db := newTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES('retiring','retiring','hash')`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE users SET deleted_at=123 WHERE id='retiring'`); err != nil {
		t.Fatal(err)
	}
	writer, err := db.Conn.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	var pid int
	if err = writer.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := writer.ExecContext(ctx, `INSERT INTO user_preferences(user_id,data) VALUES('retiring','{}')`)
		done <- err
	}()
	// Observe the lock wait before committing, rather than relying on a sleep
	// to guess whether the competing statement has taken its snapshot.
	for {
		var waiting bool
		if err = db.Conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT FROM pg_locks WHERE pid=? AND locktype='advisory' AND NOT granted)`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("personal write did not wait: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err == nil {
		t.Fatal("waiting write recreated retired personal data")
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM user_preferences WHERE user_id='retiring'`); n != 0 {
		t.Fatal("retired data persisted")
	}
}

func TestAdminActivityStatsBothDialects(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('stats-user','stats-user','hash')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('stats-server','Stats','stats-user')`},
	})
	ctx := context.Background()
	users, err := NewSQLiteUserRepo(wrapForRepo(db)).ListAllUsersWithStats(ctx)
	if err != nil || len(users) != 1 {
		t.Fatalf("user stats: %v", err)
	}
	servers, err := NewSQLiteServerRepo(wrapForRepo(db)).ListAllWithStats(ctx)
	if err != nil || len(servers) != 1 {
		t.Fatalf("server stats: %v", err)
	}
}
