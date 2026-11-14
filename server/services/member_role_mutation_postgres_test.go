package services

import (
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type roleAuditLog []models.AuditLog

func (a *roleAuditLog) Write(entry models.AuditLog) { *a = append(*a, entry) }

func TestPostgresMemberRoleReplacement(t *testing.T) {
	db := postgresServerFixture(t)
	for _, statement := range []string{
		"INSERT INTO users(id,username,password_hash) VALUES('outsider','outsider','x')",
		"INSERT INTO roles(id,server_id,name,position,permissions,is_default,is_owner) VALUES('manager','default','manager',20,2,0,0),('a','default','A',2,0,0,0),('b','default','B',3,0,0,0),('base','default','everyone',1,0,1,0),('owner','default','Owner',21,512,0,1)",
		"INSERT INTO user_roles(user_id,role_id,server_id) VALUES('sender','manager','default'),('reader','base','default')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	exec := func(t *testing.T, statement string) {
		t.Helper()
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	roles := repository.NewSQLiteRoleRepo(db)
	var log roleAuditLog
	hub := &testutil.MockEventPublisher{}
	published := 0
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) { published++ }
	invalidation := &memberInvalidator{}
	svc := NewMemberService(nil, nil, repository.NewSQLiteUserRepo(db), roles, nil, repository.NewSQLiteMemberTimeoutRepo(db), repository.NewSQLiteServerRepo(db), repository.NewServerMembershipTxRunner(db), hub, nil, &log, nil, invalidation)
	reset := func(t *testing.T) {
		exec(t, "DELETE FROM user_roles WHERE user_id='reader' AND role_id<>'base'")
		log = nil
		published = 0
		invalidation.userCalls = nil
	}
	assertEffects := func(t *testing.T, audits, events int) {
		t.Helper()
		if len(log) != audits || published != events || len(invalidation.userCalls) != events {
			t.Errorf("audits=%d published=%d cache invalidations=%v; want %d / %d / %d", len(log), published, invalidation.userCalls, audits, events, events)
		}
	}
	assertRoles := func(t *testing.T, user string, expected ...string) {
		t.Helper()
		got, err := roles.GetByUserIDAndServer(t.Context(), user, "default")
		if err != nil {
			t.Fatal(err)
		}
		set := map[string]bool{}
		for _, r := range got {
			set[r.ID] = true
		}
		if len(set) != len(expected) {
			t.Errorf("stored roles=%v want=%v", set, expected)
			return
		}
		for _, id := range expected {
			if !set[id] {
				t.Errorf("missing %q in %v", id, set)
			}
		}
	}
	t.Run("user from outside the server", func(t *testing.T) {
		reset(t)
		_, err := svc.ModifyRoles(t.Context(), "default", "sender", "outsider", []string{"a"})
		if !errors.Is(err, pkg.ErrNotFound) {
			t.Errorf("nonmember: %v, want not found", err)
		}
		assertRoles(t, "outsider")
		assertEffects(t, 0, 0)
	})
	t.Run("second write fails", func(t *testing.T) {
		reset(t)
		exec(t, "INSERT INTO user_roles(user_id,role_id,server_id) VALUES('reader','a','default')")
		exec(t, "CREATE FUNCTION fail_remove() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected removal failure'; END $$")
		exec(t, "CREATE TRIGGER fail_remove BEFORE DELETE ON user_roles FOR EACH ROW EXECUTE FUNCTION fail_remove()")
		t.Cleanup(func() { exec(t, "DROP TRIGGER fail_remove ON user_roles") })
		_, err := svc.ModifyRoles(t.Context(), "default", "sender", "reader", []string{"b"})
		if err == nil {
			t.Fatal("expected injected failure")
		}
		assertRoles(t, "reader", "base", "a")
		assertEffects(t, 0, 0)
	})
	t.Run("duplicates retry and default role", func(t *testing.T) {
		reset(t)
		payload := []string{"b", "b"}
		for i := 0; i < 2; i++ {
			if _, err := svc.ModifyRoles(t.Context(), "default", "sender", "reader", payload); err != nil {
				t.Fatal(err)
			}
		}
		assertRoles(t, "reader", "base", "b")
		assertEffects(t, 1, 1)
	})
	t.Run("cannot grant owner or peer", func(t *testing.T) {
		reset(t)
		for _, id := range []string{"owner", "manager"} {
			if _, err := svc.ModifyRoles(t.Context(), "default", "sender", "reader", []string{id}); !errors.Is(err, pkg.ErrForbidden) {
				t.Errorf("grant %q: %v", id, err)
			}
		}
		assertRoles(t, "reader", "base")
		assertEffects(t, 0, 0)
	})
	t.Run("target now holds a protected role", func(t *testing.T) {
		for _, id := range []string{"manager", "owner"} {
			reset(t)
			if _, err := db.Exec("INSERT INTO user_roles(user_id,role_id,server_id) VALUES('reader',?,'default')", id); err != nil {
				t.Fatal(err)
			}
			_, err := svc.ModifyRoles(t.Context(), "default", "sender", "reader", []string{"b"})
			if !errors.Is(err, pkg.ErrForbidden) {
				t.Fatalf("modified protected target %s: %v", id, err)
			}
			assertRoles(t, "reader", "base", id)
			assertEffects(t, 0, 0)
		}
	})
	t.Run("valid role with missing role", func(t *testing.T) {
		reset(t)
		_, err := svc.ModifyRoles(t.Context(), "default", "sender", "reader", []string{"b", "missing"})
		if !errors.Is(err, pkg.ErrForbidden) {
			t.Errorf("unexpected error: %v", err)
		}
		assertRoles(t, "reader", "base")
		assertEffects(t, 0, 0)
	})
	t.Run("deferred error at commit", func(t *testing.T) {
		reset(t)
		exec(t, "CREATE FUNCTION reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END $$")
		exec(t, "CREATE CONSTRAINT TRIGGER reject_commit AFTER INSERT ON user_roles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_commit()")
		t.Cleanup(func() { exec(t, "DROP TRIGGER reject_commit ON user_roles") })
		if _, err := svc.ModifyRoles(t.Context(), "default", "sender", "reader", []string{"a"}); err == nil {
			t.Fatal("expected deferred constraint to fail")
		}
		assertRoles(t, "reader", "base")
		assertEffects(t, 0, 0)
	})
	t.Run("replacement after concurrent grant", func(t *testing.T) {
		reset(t)
		release := releaseWhenRoleWriterWaits(t, db, "INSERT INTO user_roles(user_id,role_id,server_id) VALUES('reader','a','default')")
		done := make(chan error, 1)
		go func() {
			_, err := svc.ModifyRoles(t.Context(), "default", "sender", "reader", []string{"b"})
			done <- err
		}()
		release()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		assertRoles(t, "reader", "base", "b")
		assertEffects(t, 2, 1)
	})
	t.Run("revoked manager", func(t *testing.T) {
		reset(t)
		release := releaseWhenRoleWriterWaits(t, db, "UPDATE roles SET permissions=0 WHERE id='manager'")
		done := make(chan error, 1)
		go func() {
			_, err := svc.ModifyRoles(t.Context(), "default", "sender", "reader", []string{"a"})
			done <- err
		}()
		release()
		if err := <-done; !errors.Is(err, pkg.ErrForbidden) {
			t.Errorf("grant after manager revoked: %v", err)
		}
		assertRoles(t, "reader", "base")
		assertEffects(t, 0, 0)
	})
}
