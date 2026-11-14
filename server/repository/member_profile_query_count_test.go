package repository

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"testing"
)

type profileQueryCounter struct {
	database.TxQuerier
	queries int
}

func (q *profileQueryCounter) Unwrap() database.TxQuerier { return q.TxQuerier }
func (q *profileQueryCounter) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	q.queries++
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
