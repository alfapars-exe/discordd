package repository

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestSQLiteUserUpdateManualPresenceUpdatesStatusAndPreferenceTogether(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash) VALUES('presence-user','presence-user','x')`}})
	repo := NewSQLiteUserRepo(wrapForRepo(db))

	if err := repo.UpdateManualPresence(context.Background(), "presence-user", models.UserStatusDND); err != nil {
		t.Fatal(err)
	}
	var status, prefStatus string
	if err := db.Conn.QueryRow(`SELECT status,pref_status FROM users WHERE id='presence-user'`).Scan(&status, &prefStatus); err != nil {
		t.Fatal(err)
	}
	if status != string(models.UserStatusDND) || prefStatus != string(models.UserStatusDND) {
		t.Fatalf("manual DND persisted status=%q pref_status=%q", status, prefStatus)
	}
}

func TestSQLiteUserUpdateManualPresenceOfflineStampsLastSeenAndValidatesStatus(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash,last_seen_at) VALUES('presence-user','presence-user','x','2000-01-01 00:00:00')`}})
	repo := NewSQLiteUserRepo(wrapForRepo(db))
	var before time.Time
	if err := db.Conn.QueryRow(`SELECT last_seen_at FROM users WHERE id='presence-user'`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateManualPresence(context.Background(), "presence-user", models.UserStatusOffline); err != nil {
		t.Fatal(err)
	}
	var status, prefStatus string
	var after time.Time
	if err := db.Conn.QueryRow(`SELECT status,pref_status,last_seen_at FROM users WHERE id='presence-user'`).Scan(&status, &prefStatus, &after); err != nil {
		t.Fatal(err)
	}
	if status != string(models.UserStatusOffline) || prefStatus != string(models.UserStatusOffline) || !after.After(before) {
		t.Fatalf("offline state status=%q pref=%q last_seen=%v (before %v)", status, prefStatus, after, before)
	}
	if err := repo.UpdateManualPresence(context.Background(), "presence-user", models.UserStatus("corrupt")); err == nil {
		t.Fatal("invalid presence status was accepted")
	} else if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("invalid status error=%v, want ErrBadRequest", err)
	}
}

func TestSQLiteUserUpdateManualPresenceRespectsLifecycleAndDeletedGuards(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('disabled-user','disabled-user','x'),('deleted-user','deleted-user','x')`},
		{q: `INSERT INTO account_lifecycle(user_id,disabled_at) VALUES('disabled-user',1)`},
		{q: `UPDATE users SET deleted_at=1 WHERE id='deleted-user'`},
	})
	repo := NewSQLiteUserRepo(wrapForRepo(db))
	for _, userID := range []string{"disabled-user", "deleted-user"} {
		if err := repo.UpdateManualPresence(context.Background(), userID, models.UserStatusOnline); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("UpdateManualPresence(%q) error=%v, want ErrNotFound", userID, err)
		}
	}
}

func TestSQLiteUserUpdateManualPresenceIsAtomicOnPreferenceWriteFailure(t *testing.T) {
	db, path := newTestDBWithPath(t)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash,status,pref_status) VALUES('presence-user','presence-user','x','online','online')`}})
	if database.IsPostgresDSN(path) {
		if _, err := db.Conn.Exec(`CREATE FUNCTION fail_manual_presence_pref() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.Exec(`CREATE TRIGGER fail_manual_presence_pref BEFORE UPDATE OF pref_status ON users FOR EACH ROW EXECUTE FUNCTION fail_manual_presence_pref()`); err != nil {
			t.Fatal(err)
		}
	} else if _, err := db.Conn.Exec(`CREATE TRIGGER fail_manual_presence_pref BEFORE UPDATE OF pref_status ON users BEGIN SELECT RAISE(ABORT,'fixture failure'); END`); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteUserRepo(wrapForRepo(db))
	if err := repo.UpdateManualPresence(context.Background(), "presence-user", models.UserStatusDND); err == nil {
		t.Fatal("expected injected preference-column failure")
	}
	var status, prefStatus string
	if err := db.Conn.QueryRow(`SELECT status,pref_status FROM users WHERE id='presence-user'`).Scan(&status, &prefStatus); err != nil {
		t.Fatal(err)
	}
	if status != string(models.UserStatusOnline) || prefStatus != string(models.UserStatusOnline) {
		t.Fatalf("manual presence partially committed: status=%q pref_status=%q", status, prefStatus)
	}
}
