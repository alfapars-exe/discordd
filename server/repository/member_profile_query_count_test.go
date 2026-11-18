package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"testing"
)

type profileQueryCounter struct {
	database.TxQuerier
	queries int
	failure error
}

func (q *profileQueryCounter) Unwrap() database.TxQuerier { return q.TxQuerier }
func (q *profileQueryCounter) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	q.queries++
	if q.failure != nil {
		return nil, q.failure
	}
	return q.TxQuerier.QueryContext(ctx, query, args...)
}

func TestProfileProjectionSQLQueryCount(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	counter := &profileQueryCounter{TxQuerier: db.Conn}
	repo := NewSQLiteUserRepo(counter)
	ctx := context.Background()
	for _, size := range []int{0, 1, 1001} {
		ids := make([]string, size)
		for i := range ids {
			ids[i] = fmt.Sprintf("missing-profile-%d", i)
		}
		if size > 0 {
			ids[0] = dmAlice
		}
		counter.queries = 0
		found, err := repo.PublicUsersByID(ctx, ids)
		expectedQueries, expectedRows := 0, 0
		if size > 0 {
			expectedQueries, expectedRows = 1, 1
		}
		if err != nil || len(found) != expectedRows || counter.queries != expectedQueries {
			t.Fatalf("size=%d rows=%d queries=%d err=%v", size, len(found), counter.queries, err)
		}
	}
	counter.queries = 0
	rows, err := repo.ListServerMemberProfiles(ctx, "event-server")
	if err != nil || len(rows) != 2 || counter.queries != 1 {
		t.Fatalf("scoped profiles rows=%d queries=%d err=%v", len(rows), counter.queries, err)
	}
}

func TestProfileProjectionLargePopulationScope(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	ctx := context.Background()
	tx, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	ids := make([]string, 1001)
	for i := range ids {
		ids[i] = fmt.Sprintf("member-%04d", i)
		for _, prefix := range []string{"member", "outsider"} {
			id := fmt.Sprintf("%s-%04d", prefix, i)
			if _, err := tx.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES(?,?,?)`, id, id, "private-fixture-hash"); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO server_members(server_id,user_id) VALUES(?,?)`, "event-server", ids[i]); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	counter := &profileQueryCounter{TxQuerier: db.Conn}
	repo := NewSQLiteUserRepo(counter)
	rows, err := repo.ListServerMemberProfiles(ctx, "event-server")
	if err != nil || len(rows) != 1003 || counter.queries != 1 {
		t.Fatalf("large scope rows=%d queries=%d err=%v", len(rows), counter.queries, err)
	}
	previous := ""
	for _, row := range rows {
		if row.Username < previous || row.PasswordHash != "" {
			t.Fatal("projection ordering or credential exclusion changed")
		}
		previous = row.Username
		if row.ID != dmAlice && row.ID != dmBob && (len(row.ID) < 7 || row.ID[:7] != "member-") {
			t.Fatal("unrelated user included")
		}
	}
	counter.queries = 0
	found, err := repo.PublicUsersByID(ctx, append(ids, ids[0], "missing-profile"))
	if err != nil || len(found) != 1001 || counter.queries != 1 {
		t.Fatalf("large bulk rows=%d queries=%d err=%v", len(found), counter.queries, err)
	}
	for _, id := range ids {
		if found[id] == nil {
			t.Fatal("bulk projection dropped requested user")
		}
	}
}

func TestProfileProjectionPreservesQueryFailure(t *testing.T) {
	db := newTestDB(t)
	failure := errors.New("controlled projection query failure")
	counter := &profileQueryCounter{TxQuerier: db.Conn, failure: failure}
	repo := NewSQLiteUserRepo(counter)
	if rows, err := repo.ListServerMemberProfiles(context.Background(), "any-server"); !errors.Is(err, failure) || len(rows) != 0 {
		t.Fatal("member projection masked query failure")
	}
	if rows, err := repo.PublicUsersByID(context.Background(), []string{"any-user"}); !errors.Is(err, failure) || len(rows) != 0 {
		t.Fatal("public projection masked query failure")
	}
}
