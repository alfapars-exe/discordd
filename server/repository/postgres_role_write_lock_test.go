package repository

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/jackc/pgx/v5"
)

func TestPostgresRoleMutationWithRowFirstWriter(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires isolated local PostgreSQL")
	}
	db, _ := newPostgresTestDB(t, dsn)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	for _, s := range []string{
		"INSERT INTO users(id,username,password_hash) VALUES('u','u','h'),('victim','victim','h')",
		"INSERT INTO roles(id,server_id,name,position) VALUES('patched','s','before',1),('removed','s','removed',1),('deleted','s','deleted',1)",
		"INSERT INTO user_roles(user_id,role_id,server_id) VALUES('u','removed','s'),('victim','patched','s')",
	} {
		if _, err := db.Conn.ExecContext(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	name := "after"
	cases := []struct {
		name, competing string
		write           func(*ServerMembershipTxRepos) error
		want            error
	}{
		{"reorder and patch", "UPDATE roles SET position=2 WHERE id='patched'", func(r *ServerMembershipTxRepos) error {
			role, err := r.Role.Patch(ctx, "s", "patched", models.UpdateRoleRequest{Name: &name})
			if err == nil && role.Position != 2 {
				return errors.New("role patch did not observe completed reorder")
			}
			return err
		}, nil},
		{"cleanup and unassign", "DELETE FROM user_roles WHERE user_id='u' AND role_id='removed'", func(r *ServerMembershipTxRepos) error { return r.Role.RemoveFromUser(ctx, "u", "removed") }, nil},
		{"delete parent role and grant", "DELETE FROM roles WHERE id='deleted'", func(r *ServerMembershipTxRepos) error {
			if _, err := r.Role.GetByID(ctx, "deleted"); err != nil {
				return err
			}
			return r.Role.AssignToUser(ctx, "u", "deleted", "s")
		}, pkg.ErrNotFound},
		{"delete parent user and grant", "DELETE FROM users WHERE id='victim'", func(r *ServerMembershipTxRepos) error {
			if _, err := r.User.GetByID(ctx, "victim"); err != nil {
				return err
			}
			return r.Role.AssignToUser(ctx, "victim", "removed", "s")
		}, pkg.ErrNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			legacy, err := db.Conn.Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer legacy.Close()
			var pid int
			if err := legacy.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
				t.Fatal(err)
			}
			entered, proceed := make(chan struct{}), make(chan struct{})
			roleDone := make(chan error, 1)
			go func() {
				first := true
				roleDone <- NewServerMembershipTxRunner(db.Conn).WithServerRoles(ctx, "s", func(r *ServerMembershipTxRepos) error {
					if first {
						first = false
						close(entered)
						select {
						case <-ctx.Done():
							return ctx.Err()
						case <-proceed:
						}
					}
					return tc.write(r)
				})
			}()
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-entered:
			}
			legacyDone := make(chan error, 1)
			go func() { _, err := legacy.ExecContext(ctx, tc.competing); legacyDone <- err }()
			ticker := time.NewTicker(5 * time.Millisecond)
			defer ticker.Stop()
			for {
				var waiting bool
				if err := db.Conn.QueryRowContext(ctx, "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE pid=? AND wait_event='advisory')", pid).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-ticker.C:
				}
			}
			close(proceed)
			if err := <-legacyDone; err != nil {
				t.Errorf("row-first writer: %v", err)
			}
			if err := <-roleDone; !errors.Is(err, tc.want) {
				t.Errorf("fenced transaction: %v, want %v", err, tc.want)
			}
		})
	}
	t.Run("cancellation releases the fence while waiting for a row", func(t *testing.T) {
		holder, err := db.Conn.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer holder.Rollback()
		var pid int
		if err := holder.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
			t.Fatal(err)
		}
		if _, err := holder.ExecContext(ctx, "SELECT id FROM roles WHERE id='patched' FOR UPDATE"); err != nil {
			t.Fatal(err)
		}
		editCtx, abort := context.WithCancel(ctx)
		defer abort()
		done := make(chan error, 1)
		go func() {
			done <- NewServerMembershipTxRunner(db.Conn).WithServerRoles(editCtx, "s", func(r *ServerMembershipTxRepos) error {
				_, err := r.Role.Patch(editCtx, "s", "patched", models.UpdateRoleRequest{Name: &name})
				return err
			})
		}()
		waitForPostgresBlocker(t, ctx, db.Conn, pid)
		var free bool
		if err := db.Conn.QueryRowContext(ctx, "SELECT pg_try_advisory_xact_lock(hashtextextended('s',0))").Scan(&free); err != nil {
			t.Fatal(err)
		}
		if !free {
			t.Error("row wait held the ACL fence")
		}
		abort()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Errorf("canceled role patch: %v", err)
		}
	})

}

func TestPostgresRoleFenceUsesFreshSnapshot(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires isolated local PostgreSQL")
	}
	db, scopedDSN := newPostgresTestDB(t, dsn)
	if _, err := db.Conn.Exec("INSERT INTO roles(id,server_id,name,permissions) VALUES('r','s','role',2)"); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgx.ParseConfig(scopedDSN)
	if err != nil {
		t.Fatal(err)
	}
	cfg.RuntimeParams["default_transaction_isolation"] = "repeatable read"
	pool := database.PostgreSQLPool(cfg)
	defer pool.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	first, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback()
	var pid int
	if err := first.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := first.ExecContext(ctx, "UPDATE roles SET permissions=0 WHERE id='r'"); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		done <- NewServerMembershipTxRunner(pool).WithServerRoles(ctx, "s", func(r *ServerMembershipTxRepos) error {
			role, err := r.Role.GetByID(ctx, "r")
			if err == nil && role.Permissions != 0 {
				return errors.New("revoked permission still visible after fence wait")
			}
			return err
		})
	}()
	waitForPostgresBlocker(t, ctx, db.Conn, pid)
	if err := first.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
