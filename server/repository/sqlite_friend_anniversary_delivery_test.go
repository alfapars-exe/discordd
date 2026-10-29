package repository

import (
	"context"
	"encoding/json"
	"io/fs"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

func TestFriendAnniversaryDeliveryPersistsOptOutDecisionAndNotification(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('ann-a','anna','x'),('ann-b','benny','x')`},
		{q: `INSERT INTO friendships(id,user_id,friend_id,status,created_at,updated_at,accepted_at,anniversary_day) VALUES('ann-f','ann-a','ann-b','accepted','2020-10-24','2020-10-24','2020-10-24T12:00:00Z','10-24')`},
		{q: `INSERT INTO user_preferences(user_id,data) VALUES('ann-a','{"notifications":{"friendAnniversaryNotifications":false}}')`},
	})
	repo := NewSQLiteFriendAnniversaryDeliveryRepo(wrapForRepo(db))
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

	got, err := repo.Deliver(ctx, "ann-f", 2026, "ann-a", now)
	if err != nil || got != nil {
		t.Fatalf("opt-out delivery = %#v, %v; want nil decision", got, err)
	}
	if _, err := db.Conn.Exec(`UPDATE user_preferences SET data='{}' WHERE user_id='ann-a'`); err != nil {
		t.Fatal(err)
	}
	got, err = repo.Deliver(ctx, "ann-f", 2026, "ann-a", now)
	if err != nil || got != nil {
		t.Fatalf("second same-day delivery = %#v, %v; opted-out decision must not retro-send", got, err)
	}
	if got, err = repo.Deliver(ctx, "ann-f", 2026, "ann-b", now); err != nil || got == nil {
		t.Fatalf("enabled recipient delivery = %#v, %v", got, err)
	} else {
		if got.UserID != "ann-b" || got.ActorID == nil || *got.ActorID != "ann-a" || got.Kind != "system" {
			t.Fatalf("unexpected notification: %+v", got)
		}
		var payload map[string]any
		if err := json.Unmarshal(got.Payload, &payload); err != nil || payload["action"] != "friend_anniversary" || payload["years"] != float64(6) {
			t.Fatalf("unexpected payload %s (%v)", got.Payload, err)
		}
	}
	if _, err := db.Conn.Exec(`DELETE FROM notifications WHERE user_id='ann-b'`); err != nil {
		t.Fatal(err)
	}
	if got, err := repo.Deliver(ctx, "ann-f", 2026, "ann-b", now); err != nil || got != nil {
		t.Fatalf("deleted notification was recreated: %#v, %v", got, err)
	}
	if countRows(t, db, `SELECT COUNT(*) FROM friendship_anniversary_deliveries WHERE anniversary_year=2026`) != 2 {
		t.Fatal("delivery decisions were not retained for both recipients")
	}
}

func TestFriendAnniversaryDeliveryRejectsBlockedOrInactiveActor(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup string
	}{
		{name: "block", setup: `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('ann-block','ann-b','ann-a','blocked')`},
		{name: "bot actor", setup: `UPDATE users SET is_bot=1 WHERE id='ann-b'`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := newTestDB(t)
			execSeed(t, db, []seedStmt{
				{q: `INSERT INTO users(id,username,password_hash) VALUES('ann-a','anna','x'),('ann-b','benny','x')`},
				{q: `INSERT INTO friendships(id,user_id,friend_id,status,accepted_at,anniversary_day) VALUES('ann-f','ann-a','ann-b','accepted','2020-10-24T12:00:00Z','10-24')`},
			})
			if _, err := db.Conn.Exec(tc.setup); err != nil {
				t.Fatal(err)
			}
			repo := NewSQLiteFriendAnniversaryDeliveryRepo(wrapForRepo(db))
			got, err := repo.Deliver(context.Background(), "ann-f", 2026, "ann-a", time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC))
			if err != nil || got != nil {
				t.Fatalf("delivery = %#v, %v; want fail-closed nil", got, err)
			}
			if n := countRows(t, db, `SELECT COUNT(*) FROM friendship_anniversary_deliveries`); n != 0 {
				t.Fatalf("ineligible pair recorded %d delivery decisions", n)
			}
		})
	}
}

func TestFriendAnniversaryDueUsesFeb28ForNonLeapFeb29(t *testing.T) {
	accepted := time.Date(2020, 2, 29, 12, 0, 0, 0, time.UTC)
	if !friendAnniversaryDue("02-29", accepted, 2025, time.Date(2025, 2, 28, 9, 0, 0, 0, time.UTC)) {
		t.Fatal("Feb 29 relationship anniversary should be observed on Feb 28 in non-leap years")
	}
	if friendAnniversaryDue("02-29", accepted, 2024, time.Date(2024, 2, 28, 9, 0, 0, 0, time.UTC)) {
		t.Fatal("leap-year anniversary should remain Feb 29")
	}
}

func TestFriendshipAcceptanceTimestampIsSetOnce(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('accept-a','accepta','x'),('accept-b','acceptb','x')`},
		{q: `INSERT INTO friendships(id,user_id,friend_id,status,created_at,updated_at) VALUES('accept-f','accept-a','accept-b','pending','2018-02-03T04:05:06Z','2018-02-03T04:05:06Z')`},
	})
	repo := NewSQLiteFriendshipRepo(wrapForRepo(db))
	if err := repo.UpdateStatus(context.Background(), "accept-f", models.FriendshipStatusAccepted); err != nil {
		t.Fatal(err)
	}
	var first string
	if err := db.Conn.QueryRow(`SELECT CAST(accepted_at AS TEXT) FROM friendships WHERE id='accept-f'`).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE friendships SET updated_at='2030-01-01T00:00:00Z' WHERE id='accept-f'`); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateStatus(context.Background(), "accept-f", models.FriendshipStatusAccepted); err != nil {
		t.Fatal(err)
	}
	var second, day string
	if err := db.Conn.QueryRow(`SELECT CAST(accepted_at AS TEXT),anniversary_day FROM friendships WHERE id='accept-f'`).Scan(&second, &day); err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("repeated acceptance moved anniversary from %q to %q", first, second)
	}
	acceptedAt, err := time.Parse(time.RFC3339Nano, serverEventTimeAPI(second))
	if err != nil || day != acceptedAt.UTC().Format("01-02") {
		t.Fatalf("accepted_at/day mismatch: accepted_at=%q day=%q err=%v", second, day, err)
	}
	repoDeliveries := NewSQLiteFriendAnniversaryDeliveryRepo(wrapForRepo(db))
	anniversaryYear := acceptedAt.UTC().Year() + 1
	anniversaryDate := time.Date(anniversaryYear, acceptedAt.UTC().Month(), acceptedAt.UTC().Day(), acceptedAt.UTC().Hour(), acceptedAt.UTC().Minute(), acceptedAt.UTC().Second(), acceptedAt.UTC().Nanosecond(), time.UTC)
	if day == "02-29" && !isLeapYear(anniversaryYear) {
		anniversaryDate = time.Date(anniversaryYear, time.February, 28, 12, 0, 0, 0, time.UTC)
	}
	candidates, err := repoDeliveries.DueCandidates(context.Background(), anniversaryDate.Format("01-02"), anniversaryDate.Format("01-02") == "02-28" && !isLeapYear(anniversaryYear), "", 10)
	if err != nil || len(candidates) != 1 || candidates[0].AcceptedAt.UTC() != acceptedAt.UTC() {
		t.Fatalf("fresh acceptance candidate = %+v, %v", candidates, err)
	}
	if notification, err := repoDeliveries.Deliver(context.Background(), "accept-f", anniversaryYear, "accept-a", anniversaryDate); err != nil || notification == nil {
		t.Fatalf("fresh acceptance delivery = %#v, %v", notification, err)
	}
}

func TestFriendAnniversaryMigrationBackfillsHistoricalGoTime(t *testing.T) {
	baseFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	entries, err := fs.ReadDir(baseFS, ".")
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{}
	for _, entry := range entries {
		if entry.Name() == "128_friend_anniversary_deliveries.sql" {
			continue
		}
		data, err := fs.ReadFile(baseFS, entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		files[entry.Name()] = &fstest.MapFile{Data: data}
	}
	db, err := database.NewLegacy(filepath.Join(t.TempDir(), "anniversary_migration.db"), files)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	acceptedAt := time.Date(2020, time.February, 29, 12, 34, 56, 123456700, time.UTC)
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('legacy-a','legacya','x'),('legacy-b','legacyb','x')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO friendships(id,user_id,friend_id,status,created_at,updated_at) VALUES('legacy-f','legacy-a','legacy-b','accepted',?,?)`, acceptedAt, acceptedAt); err != nil {
		t.Fatal(err)
	}
	migration, err := fs.ReadFile(database.EmbeddedMigrations, "migrations/128_friend_anniversary_deliveries.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(string(migration)); err != nil {
		t.Fatal(err)
	}
	var rawAcceptedAt, day string
	if err := db.Conn.QueryRow(`SELECT CAST(accepted_at AS TEXT),anniversary_day FROM friendships WHERE id='legacy-f'`).Scan(&rawAcceptedAt, &day); err != nil {
		t.Fatal(err)
	}
	parsed, err := parseFriendAnniversaryTimestamp(rawAcceptedAt)
	if err != nil || !parsed.Equal(acceptedAt) || day != "02-29" {
		t.Fatalf("migration backfill accepted_at=%q parsed=%s day=%q err=%v", rawAcceptedAt, parsed, day, err)
	}
	repo := NewSQLiteFriendAnniversaryDeliveryRepo(wrapForRepo(db))
	candidates, err := repo.DueCandidates(context.Background(), "02-28", true, "", 10)
	if err != nil || len(candidates) != 1 || !candidates[0].AcceptedAt.Equal(acceptedAt) {
		t.Fatalf("historical migrated candidate = %+v, %v", candidates, err)
	}
	notification, err := repo.Deliver(context.Background(), "legacy-f", 2025, "legacy-a", time.Date(2025, time.February, 28, 12, 0, 0, 0, time.UTC))
	if err != nil || notification == nil {
		t.Fatalf("historical migrated delivery = %#v, %v", notification, err)
	}
}

func TestFriendAnniversaryMalformedPreferencesFailClosedAndRecordDecision(t *testing.T) {
	for name, raw := range map[string]string{
		"null root":        `null`,
		"nonnumeric value": `{"notifications":{"friendAnniversaryNotifications":1}}`,
		"invalid object":   `{"notifications":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			db := newTestDB(t)
			execSeed(t, db, []seedStmt{
				{q: `INSERT INTO users(id,username,password_hash) VALUES('mal-a','mala','x'),('mal-b','malb','x')`},
				{q: `INSERT INTO friendships(id,user_id,friend_id,status,accepted_at,anniversary_day) VALUES('mal-f','mal-a','mal-b','accepted','2020-10-24T12:00:00Z','10-24')`},
			})
			if _, err := db.Conn.Exec(`INSERT INTO user_preferences(user_id,data) VALUES(?,?)`, "mal-a", raw); err != nil {
				t.Fatal(err)
			}
			repo := NewSQLiteFriendAnniversaryDeliveryRepo(wrapForRepo(db))
			got, err := repo.Deliver(context.Background(), "mal-f", 2026, "mal-a", time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC))
			if err != nil || got != nil {
				t.Fatalf("malformed preference delivery = %#v, %v; want fail-closed nil", got, err)
			}
			if countRows(t, db, `SELECT COUNT(*) FROM friendship_anniversary_deliveries WHERE recipient_id='mal-a'`) != 1 || countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE user_id='mal-a'`) != 0 {
				t.Fatal("malformed preference must persist a no-notification decision")
			}
		})
	}
}

func TestFriendAnniversaryNotificationInsertFailureRollsBackDecision(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('fail-a','faila','x'),('fail-b','failb','x')`},
		{q: `INSERT INTO friendships(id,user_id,friend_id,status,accepted_at,anniversary_day) VALUES('fail-f','fail-a','fail-b','accepted','2020-10-24T12:00:00Z','10-24')`},
	})
	if database.IsPostgres(db.Conn) {
		if _, err := db.Conn.Exec(`CREATE FUNCTION fail_friend_anniversary_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture insert failure'; END $$`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.Exec(`CREATE TRIGGER fail_friend_anniversary_notification BEFORE INSERT ON notifications FOR EACH ROW WHEN (NEW.id LIKE 'friend-anniversary:%') EXECUTE FUNCTION fail_friend_anniversary_notification()`); err != nil {
			t.Fatal(err)
		}
	} else {
		if _, err := db.Conn.Exec(`CREATE TRIGGER fail_friend_anniversary_notification BEFORE INSERT ON notifications WHEN NEW.id LIKE 'friend-anniversary:%' BEGIN SELECT RAISE(ABORT,'fixture insert failure'); END`); err != nil {
			t.Fatal(err)
		}
	}
	repo := NewSQLiteFriendAnniversaryDeliveryRepo(wrapForRepo(db))
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	if got, err := repo.Deliver(context.Background(), "fail-f", 2026, "fail-a", now); err == nil || got != nil {
		t.Fatalf("injected insert failure = %#v, %v; want error", got, err)
	}
	if countRows(t, db, `SELECT COUNT(*) FROM friendship_anniversary_deliveries`) != 0 || countRows(t, db, `SELECT COUNT(*) FROM notifications`) != 0 {
		t.Fatal("notification failure left a partial decision or inbox row")
	}
	if database.IsPostgres(db.Conn) {
		if _, err := db.Conn.Exec(`DROP TRIGGER fail_friend_anniversary_notification ON notifications`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.Exec(`DROP FUNCTION fail_friend_anniversary_notification()`); err != nil {
			t.Fatal(err)
		}
	} else {
		if _, err := db.Conn.Exec(`DROP TRIGGER fail_friend_anniversary_notification`); err != nil {
			t.Fatal(err)
		}
	}
	got, err := repo.Deliver(context.Background(), "fail-f", 2026, "fail-a", now)
	if err != nil || got == nil {
		t.Fatalf("retry after removing failure trigger = %#v, %v", got, err)
	}
	if countRows(t, db, `SELECT COUNT(*) FROM friendship_anniversary_deliveries`) != 1 {
		t.Fatal("successful retry did not persist exactly one decision")
	}
}
