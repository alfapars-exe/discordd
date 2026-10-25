package repository

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"os"
	"testing"
	"time"
)

func TestGroupAdmissionTransactionRejectsNonfriendsAndRetainsNoPartialState(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	base := &models.GroupDM{ID: "existing", OwnerID: dmAlice, Name: "Existing", KeyEpoch: 1, CallRoomKey: "room"}
	if err := repo.Create(ctx, base, []string{dmAlice}); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"missing", "pending", "blocked"} {
		t.Run(status, func(t *testing.T) {
			if _, err := db.Conn.Exec(`DELETE FROM friendships`); err != nil {
				t.Fatal(err)
			}
			if status != "missing" {
				if _, err := db.Conn.Exec(`INSERT INTO friendships(id,user_id,friend_id,status) VALUES('pair',?,?,?)`, dmAlice, dmBob, status); err != nil {
					t.Fatal(err)
				}
			}
			g := &models.GroupDM{ID: "denied", OwnerID: dmAlice, Name: "Denied", KeyEpoch: 1, CallRoomKey: "denied"}
			if err := repo.Create(ctx, g, []string{dmAlice, dmBob}, dmAlice); !errors.Is(err, pkg.ErrForbidden) {
				t.Fatalf("create=%v", err)
			}
			if _, err := repo.AddMember(ctx, "existing", dmBob, dmAlice); !errors.Is(err, pkg.ErrForbidden) {
				t.Fatalf("add=%v", err)
			}
			var groups, members, reads, notices int
			if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM group_dm_channels WHERE id='denied'`).Scan(&groups); err != nil {
				t.Fatal(err)
			}
			if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM group_dm_members WHERE user_id=?`, dmBob).Scan(&members); err != nil {
				t.Fatal(err)
			}
			if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM group_dm_reads WHERE user_id=?`, dmBob).Scan(&reads); err != nil {
				t.Fatal(err)
			}
			if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM notifications`).Scan(&notices); err != nil {
				t.Fatal(err)
			}
			after, err := repo.GetByID(ctx, "existing")
			if err != nil {
				t.Fatal(err)
			}
			if groups+members+reads+notices != 0 || after.KeyEpoch != 1 {
				t.Fatalf("partial admission groups=%d members=%d reads=%d notices=%d epoch=%d", groups, members, reads, notices, after.KeyEpoch)
			}
		})
	}
	if _, err := db.Conn.Exec(`DELETE FROM friendships`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO friendships(id,user_id,friend_id,status) VALUES('friend',?,?,'accepted')`, dmBob, dmAlice); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AddMember(ctx, "existing", dmBob, dmAlice); err != nil {
		t.Fatal(err)
	}
	g := &models.GroupDM{ID: "allowed", OwnerID: dmAlice, Name: "Allowed", KeyEpoch: 1, CallRoomKey: "allowed"}
	if err := repo.Create(ctx, g, []string{dmAlice, dmBob}, dmAlice); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`DELETE FROM friendships`); err != nil {
		t.Fatal(err)
	}
	cipher, device := "cipher", "device"
	if err := repo.CreateMessage(ctx, &models.GroupDMMessage{ID: "old-member-send", GroupID: "allowed", UserID: dmBob, EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, KeyEpoch: 1}); err != nil {
		t.Fatalf("existing membership changed by admission-only gate: %v", err)
	}
}
func TestGroupAdmissionScopeCannotDowngradeSuppliedEmptyOrMultipleActor(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	g := &models.GroupDM{ID: "existing", OwnerID: dmAlice, Name: "Existing", KeyEpoch: 1, CallRoomKey: "room"}
	if err := repo.Create(ctx, g, []string{dmAlice}); err != nil {
		t.Fatal(err)
	}
	for _, actors := range [][]string{{""}, {dmAlice, dmAlice}, {" "}, {dmBob}} {
		err := repo.Create(ctx, &models.GroupDM{ID: "new", OwnerID: dmAlice, Name: "New", KeyEpoch: 1, CallRoomKey: "new"}, []string{dmAlice, dmBob}, actors...)
		if err == nil {
			t.Fatal("invalid create actor admitted")
		}
		if _, err := repo.AddMember(ctx, "existing", dmBob, actors...); err == nil {
			t.Fatal("invalid add actor admitted")
		}
	}
	member, err := repo.IsMember(ctx, "existing", dmBob)
	if err != nil || member {
		t.Fatalf("target admitted member=%v err=%v", member, err)
	}
}
func TestGroupAdmissionTransactionRejectsAcceptedPairWhenOppositeBlockExists(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	for _, row := range []struct{ id, a, b, status string }{{"friend", dmAlice, dmBob, "accepted"}, {"block", dmBob, dmAlice, "blocked"}} {
		if _, err := db.Conn.Exec(`INSERT INTO friendships(id,user_id,friend_id,status) VALUES(?,?,?,?)`, row.id, row.a, row.b, row.status); err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.Create(ctx, &models.GroupDM{ID: "new", OwnerID: dmAlice, Name: "New", KeyEpoch: 1, CallRoomKey: "new"}, []string{dmAlice, dmBob}, dmAlice); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("opposite block=%v", err)
	}
}

// Actual PostgreSQL barrier: pause member insertion after admission locked the
// accepted pair, then prove an unfriend DELETE cannot commit ahead of admission.
func TestGroupAdmissionPostgresSerializesConcurrentUnfriendThroughCommit(t *testing.T) {
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires isolated loopback PostgreSQL fixture")
	}
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('pair',?,?,'accepted')`, dmAlice, dmBob); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.ExecContext(ctx, `CREATE FUNCTION group_admission_test_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='u-bob' THEN PERFORM pg_advisory_xact_lock(9138271); END IF; RETURN NEW; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.ExecContext(ctx, `CREATE TRIGGER group_admission_test_barrier BEFORE INSERT ON group_dm_members FOR EACH ROW EXECUTE FUNCTION group_admission_test_barrier()`); err != nil {
		t.Fatal(err)
	}
	gate, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Rollback()
	if _, err := gate.ExecContext(ctx, `SELECT pg_advisory_xact_lock(9138271)`); err != nil {
		t.Fatal(err)
	}
	admitted := make(chan error, 1)
	go func() {
		admitted <- repo.Create(ctx, &models.GroupDM{ID: "serial-group", OwnerID: dmAlice, Name: "Serial", KeyEpoch: 1, CallRoomKey: "serial"}, []string{dmAlice, dmBob}, dmAlice)
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var waiting bool
		if err := db.Conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9138271 AND NOT granted)`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("admission never reached locked insertion barrier")
		}
		time.Sleep(10 * time.Millisecond)
	}
	removed := make(chan error, 1)
	go func() { _, err := db.Conn.ExecContext(ctx, `DELETE FROM friendships WHERE id='pair'`); removed <- err }()
	deadline = time.Now().Add(3 * time.Second)
	for {
		select {
		case err := <-removed:
			t.Fatalf("unfriend committed ahead of locked admission: %v", err)
		default:
		}
		var blocked bool
		if err := db.Conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM friendships WHERE id=%')`).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("unfriend never reached the locked accepted pair")
		}
		time.Sleep(10 * time.Millisecond)
	}

	if err := gate.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-admitted; err != nil {
		t.Fatal(err)
	}
	if err := <-removed; err != nil {
		t.Fatal(err)
	}
	member, err := repo.IsMember(ctx, "serial-group", dmBob)
	if err != nil || !member {
		t.Fatalf("serialized accepted member missing=%v err=%v", member, err)
	}
}

func TestGroupAdmissionMixedRecipientSetRejectsAtomically(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	if _, err := db.Conn.Exec(`INSERT INTO friendships(id,user_id,friend_id,status) VALUES('friend',?,?,'accepted')`, dmAlice, dmBob); err != nil {
		t.Fatal(err)
	}
	err := repo.Create(ctx, &models.GroupDM{ID: "mixed", OwnerID: dmAlice, Name: "Mixed", KeyEpoch: 1, CallRoomKey: "mixed"}, []string{dmAlice, dmBob, dmCarol}, dmAlice)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("mixed recipient set=%v", err)
	}
	var channels, members, reads int
	for query, destination := range map[string]*int{`SELECT COUNT(*) FROM group_dm_channels`: &channels, `SELECT COUNT(*) FROM group_dm_members`: &members, `SELECT COUNT(*) FROM group_dm_reads`: &reads} {
		if err := db.Conn.QueryRow(query).Scan(destination); err != nil {
			t.Fatal(err)
		}
	}
	if channels+members+reads != 0 {
		t.Fatalf("partially admitted mixed group=%d/%d/%d", channels, members, reads)
	}
}
