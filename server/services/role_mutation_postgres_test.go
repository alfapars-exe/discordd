package services

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// The first writer holds its change uncommitted while the real service starts
// on a second connection. Observe the database wait instead of guessing when
// the second request has reached its authorization/write boundary.
func releaseWhenRoleWriterWaits(t *testing.T, db *sql.DB, statement string) func() {
	t.Helper()
	first, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Rollback() })
	var pid int
	if err := first.QueryRow("SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err = first.Exec(statement); err != nil {
		t.Fatal(err)
	}
	return func() {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			var waiting bool
			if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid)))", pid).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting {
				break
			}
			select {
			case <-ctx.Done():
				t.Fatal("role mutation never waited on the first writer", ctx.Err())
			case <-ticker.C:
			}
		}
		if err := first.Commit(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPostgresRolePatchConcurrentChanges(t *testing.T) {
	db := postgresServerFixture(t)
	for _, statement := range []string{
		"INSERT INTO roles(id,server_id,name,position,permissions) VALUES('manager','default','manager',20,514),('edited','default','before',2,64)",
		"INSERT INTO user_roles(user_id,role_id,server_id) VALUES('sender','manager','default')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	published := make(chan *models.Role, 1)
	hub := &testutil.MockBroadcaster{BroadcastToServerFn: func(_ string, e ws.Event) { published <- e.Data.(*models.Role) }}
	roles := repository.NewSQLiteRoleRepo(db)
	svc := NewRoleService(roles, repository.NewServerMembershipTxRunner(db), hub, nil)
	name := "after"
	zero := models.Permission(0)
	for _, tc := range []struct {
		name  string
		first string
		patch models.UpdateRoleRequest
	}{
		{"revoke then rename", "UPDATE roles SET permissions=0 WHERE id='edited'", models.UpdateRoleRequest{Name: &name}},
		{"rename then revoke", "UPDATE roles SET name='after' WHERE id='edited'", models.UpdateRoleRequest{Permissions: &zero}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := db.Exec("UPDATE roles SET name='before',permissions=64 WHERE id='edited'"); err != nil {
				t.Fatal(err)
			}
			release := releaseWhenRoleWriterWaits(t, db, tc.first)
			type result struct {
				role *models.Role
				err  error
			}
			done := make(chan result, 1)
			go func() {
				role, err := svc.Update(t.Context(), "default", "sender", "edited", &tc.patch)
				done <- result{role, err}
			}()
			release()
			res := <-done
			if res.err != nil {
				t.Fatal(res.err)
			}
			got, err := roles.GetByID(t.Context(), "edited")
			if err != nil {
				t.Fatal(err)
			}
			for _, view := range []*models.Role{got, res.role, <-published} {
				if view.Name != name || view.Permissions != 0 {
					t.Errorf("database/response/broadcast lost a completed patch: name=%q permissions=%d", view.Name, view.Permissions)
				}
			}
		})
	}
	t.Run("owner fields and scoped role lookup", func(t *testing.T) {
		if _, err := db.Exec("INSERT INTO roles(id,server_id,name,position,permissions,is_owner) VALUES('chief','default','Owner',1,512,1)"); err != nil {
			t.Fatal(err)
		}
		disabled := false
		if _, err := svc.Update(t.Context(), "default", "sender", "chief", &models.UpdateRoleRequest{Name: &name}); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("manager edited owner: %v", err)
		}
		if _, err := db.Exec("INSERT INTO user_roles(user_id,role_id,server_id) VALUES('reader','chief','default')"); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.Update(t.Context(), "default", "reader", "chief", &models.UpdateRoleRequest{Permissions: &zero}); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("owner changed protected mask: %v", err)
		}
		if _, err := svc.Update(t.Context(), "default", "reader", "chief", &models.UpdateRoleRequest{Name: &name, Mentionable: &disabled}); err != nil {
			t.Fatal(err)
		}
		if role := <-published; role.Name != name || !role.Mentionable || role.Permissions != models.PermAdmin {
			t.Fatalf("owner cosmetic PATCH: %+v", role)
		}
		if _, err := roles.Patch(t.Context(), "foreign", "edited", models.UpdateRoleRequest{Mentionable: &disabled}); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("cross-server patch: %v", err)
		}
		color := "#010203"
		if _, err := svc.Update(t.Context(), "default", "sender", "edited", &models.UpdateRoleRequest{Color: &color, Mentionable: &disabled}); err != nil {
			t.Fatal(err)
		}
		if role := <-published; role.Mentionable || role.Color != color {
			t.Fatalf("false mentionability and color: %+v", role)
		}
	})
	t.Run("actor loses manage roles while request waits", func(t *testing.T) {
		release := releaseWhenRoleWriterWaits(t, db, "UPDATE roles SET permissions=0 WHERE id='manager'")
		done := make(chan error, 1)
		go func() {
			_, err := svc.Update(t.Context(), "default", "sender", "edited", &models.UpdateRoleRequest{Name: &name})
			done <- err
		}()
		release()
		if err := <-done; !errors.Is(err, pkg.ErrForbidden) {
			t.Errorf("after revocation: %v", err)
		}
		if len(published) != 0 {
			t.Error("rejected role change was published")
		}
	})
}
