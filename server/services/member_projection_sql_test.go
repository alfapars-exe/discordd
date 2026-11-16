package services

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/repository"
)

type memberSQLCounter struct {
	database.TxQuerier
	queries int
}

func (c *memberSQLCounter) Unwrap() database.TxQuerier { return c.TxQuerier }
func (c *memberSQLCounter) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	c.queries++
	return c.TxQuerier.QueryContext(ctx, query, args...)
}
func (c *memberSQLCounter) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	c.queries++
	return c.TxQuerier.QueryRowContext(ctx, query, args...)
}

// Real SQL with the full migrated schema on either configured test backend.
func TestMemberProjectionPhysicalSQLCount(t *testing.T) {
	db := newDMSendTestDB(t)
	ctx := context.Background()
	tx, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for i := 0; i < 1002; i++ {
		id := fmt.Sprintf("projection-%04d", i)
		if _, err := tx.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES(?,?,?)`, id, id, "private-test-hash"); err != nil {
			t.Fatal(err)
		}
	}
	expires := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	for _, size := range []int{0, 1, 1001} {
		server := fmt.Sprintf("projection-server-%d", size)
		if _, err := tx.ExecContext(ctx, `INSERT INTO servers(id,name,owner_id) VALUES(?,?,?)`, server, server, "projection-1001"); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < size; i++ {
			if _, err := tx.ExecContext(ctx, `INSERT INTO server_members(server_id,user_id) VALUES(?,?)`, server, fmt.Sprintf("projection-%04d", i)); err != nil {
				t.Fatal(err)
			}
		}
		if size > 0 {
			for _, statement := range []struct {
				query string
				args  []any
			}{
				{`INSERT INTO roles(id,server_id,name,position,permissions,is_default,is_owner) VALUES(?,?,?,2,0,0,0)`, []any{server + "-role", server, "Scoped role"}},
				{`INSERT INTO user_roles(user_id,role_id,server_id) VALUES(?,?,?)`, []any{"projection-0000", server + "-role", server}},
				{`UPDATE server_members SET nickname=? WHERE server_id=? AND user_id=?`, []any{server + "-nickname", server, "projection-0000"}},
				{`INSERT INTO member_timeouts(server_id,user_id,expires_at,applied_by,reason) VALUES(?,?,?,?,?)`, []any{server, "projection-0000", expires.Format("2006-01-02 15:04:05"), "projection-1001", server}},
			} {
				if _, err := tx.ExecContext(ctx, statement.query, statement.args...); err != nil {
					t.Fatal(err)
				}
			}
		}

	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	counter := &memberSQLCounter{TxQuerier: db.Conn}
	svc := &memberService{memberReader: memberReader{
		userRepo:    repository.NewSQLiteUserRepo(counter),
		roleRepo:    repository.NewSQLiteRoleRepo(counter),
		serverRepo:  repository.NewSQLiteServerRepo(counter),
		timeoutRepo: repository.NewSQLiteMemberTimeoutRepo(counter),
	}}
	for _, size := range []int{0, 1, 1001} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			counter.queries = 0
			rows, err := svc.GetAll(ctx, fmt.Sprintf("projection-server-%d", size))
			expectedQueries := 4
			if size == 0 {
				expectedQueries = 3
			}
			if err != nil || len(rows) != size || counter.queries != expectedQueries {
				t.Fatalf("members=%d SQL=%d want=%d err=%v", len(rows), counter.queries, expectedQueries, err)
			}
			if size > 0 {
				first := rows[0]
				server := fmt.Sprintf("projection-server-%d", size)
				if len(first.Roles) != 1 || first.Roles[0].ID != server+"-role" || first.Nickname == nil || *first.Nickname != server+"-nickname" || first.TimeoutExpiresAt == nil || !first.TimeoutExpiresAt.Equal(expires) {
					t.Fatal("scoped role/nickname/timeout enrichment differs")
				}
			}
			for i, row := range rows {
				if i > 0 && (len(row.Roles) != 0 || row.Nickname != nil || row.TimeoutExpiresAt != nil) {
					t.Fatal("enrichment leaked to unrelated member")
				}
				if row.ID != fmt.Sprintf("projection-%04d", i) {
					t.Fatal("member scope or username order changed")
				}
			}
		})
	}
}
