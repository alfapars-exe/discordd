package repository

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/jackc/pgx/v5/pgconn"
)

func newOnlineFriendNotificationFixture(t *testing.T, actorPrefs, recipientPrefs string) *database.DB {
	t.Helper()
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,status) VALUES('online-actor','onlineactor','x','online'),('online-recipient','onlinerecipient','x','online')`},
		{q: `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('online-friendship','online-actor','online-recipient','accepted')`},
	})
	if actorPrefs != "" {
		if _, err := db.Conn.Exec(`INSERT INTO user_preferences(user_id,data) VALUES('online-actor',?)`, actorPrefs); err != nil {
			t.Fatal(err)
		}
	}
	if recipientPrefs != "" {
		if _, err := db.Conn.Exec(`INSERT INTO user_preferences(user_id,data) VALUES('online-recipient',?)`, recipientPrefs); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func newOnlineFriendNotice() *models.Notification {
	actor := "online-actor"
	return &models.Notification{
		UserID: "online-recipient", Kind: models.NotificationKindSystem, ActorID: &actor,
		Payload: json.RawMessage(`{"title":"Friend is online","body":"Actor is now online."}`),
	}
}

func TestOnlineFriendNotificationRequiresCurrentAcceptedEdgeAndNoBlock(t *testing.T) {
	tests := []struct {
		name   string
		mutate string
		want   bool
	}{
		{name: "accepted current edge", want: true},
		{name: "removed after candidate discovery", mutate: `DELETE FROM friendships WHERE id='online-friendship'`},
		{name: "pending edge", mutate: `UPDATE friendships SET status='pending' WHERE id='online-friendship'`},
		{name: "block in either direction", mutate: `UPDATE friendships SET status='blocked' WHERE id='online-friendship'`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			db := newOnlineFriendNotificationFixture(t, `{"privacy":{"shareOnlineUpdates":true}}`, `{"notifications":{"onlineFriendNotifications":true}}`)
			if tc.mutate != "" {
				if _, err := db.Conn.Exec(tc.mutate); err != nil {
					t.Fatal(err)
				}
			}
			repo := NewSQLiteNotificationRepo(wrapForRepo(db)).(OnlineFriendNotificationRepository)
			created, err := repo.CreateIfOnlineFriendEligible(context.Background(), "online-actor", "online-recipient", newOnlineFriendNotice())
			if err != nil {
				t.Fatalf("guarded create: %v", err)
			}
			if (created != nil) != tc.want {
				t.Fatalf("created = %#v, want eligibility %v", created, tc.want)
			}
			wantRows := 0
			if tc.want {
				wantRows = 1
				if created.ID == "" || created.CreatedAt == "" || created.UserID != "online-recipient" || created.ActorID == nil || *created.ActorID != "online-actor" {
					t.Fatalf("committed notification missing fields: %+v", created)
				}
			}
			if got := countRows(t, db, `SELECT COUNT(*) FROM notifications`); got != wantRows {
				t.Fatalf("notification rows = %d, want %d", got, wantRows)
			}
		})
	}
}

func TestOnlineFriendNotificationRechecksActorAndRecipientPreferences(t *testing.T) {
	tests := []struct {
		name      string
		actor     string
		recipient string
		want      bool
	}{
		{name: "actor explicitly opted in", actor: `{"privacy":{"shareOnlineUpdates":true}}`, recipient: `{"notifications":{"onlineFriendNotifications":true}}`, want: true},
		{name: "actor opted out", actor: `{"privacy":{"shareOnlineUpdates":false}}`, recipient: `{"notifications":{"onlineFriendNotifications":true}}`},
		{name: "recipient opted out", actor: `{"privacy":{"shareOnlineUpdates":true}}`, recipient: `{"notifications":{"onlineFriendNotifications":false}}`},
		{name: "recipient preference absent defaults off", actor: `{"privacy":{"shareOnlineUpdates":true}}`},
		{name: "recipient preference key absent defaults off", actor: `{"privacy":{"shareOnlineUpdates":true}}`, recipient: `{"notifications":{"sound":true}}`},
		{name: "actor share preference absent defaults on", recipient: `{"notifications":{"onlineFriendNotifications":true}}`, want: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			db := newOnlineFriendNotificationFixture(t, tc.actor, tc.recipient)
			repo := NewSQLiteNotificationRepo(wrapForRepo(db)).(OnlineFriendNotificationRepository)
			created, err := repo.CreateIfOnlineFriendEligible(context.Background(), "online-actor", "online-recipient", newOnlineFriendNotice())
			if err != nil || (created != nil) != tc.want {
				t.Fatalf("guarded create = %#v, %v; want eligible=%v", created, err, tc.want)
			}
		})
	}
}

func TestOnlineFriendNotificationFailsClosedForInactiveAccountsOrMalformedPreferences(t *testing.T) {
	tests := []struct {
		name   string
		mutate string
		prefs  string
	}{
		{name: "actor offline", mutate: `UPDATE users SET status='offline' WHERE id='online-actor'`},
		{name: "recipient disabled", mutate: `INSERT INTO account_lifecycle(user_id,disabled_at) VALUES('online-recipient',1)`},
		{name: "malformed recipient preferences", prefs: "not-json"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			db := newOnlineFriendNotificationFixture(t, `{"privacy":{"shareOnlineUpdates":true}}`, `{"notifications":{"onlineFriendNotifications":true}}`)
			if tc.mutate != "" {
				if _, err := db.Conn.Exec(tc.mutate); err != nil {
					t.Fatal(err)
				}
			}
			if tc.prefs != "" {
				if _, err := db.Conn.Exec(`UPDATE user_preferences SET data=? WHERE user_id='online-recipient'`, tc.prefs); err != nil {
					t.Fatal(err)
				}
			}
			repo := NewSQLiteNotificationRepo(wrapForRepo(db)).(OnlineFriendNotificationRepository)
			created, err := repo.CreateIfOnlineFriendEligible(context.Background(), "online-actor", "online-recipient", newOnlineFriendNotice())
			if tc.prefs != "" {
				if err == nil || created != nil {
					t.Fatalf("malformed prefs result = %#v, %v; want fail-closed error", created, err)
				}
			} else if err != nil || created != nil {
				t.Fatalf("inactive-account result = %#v, %v; want no notice", created, err)
			}
			if got := countRows(t, db, `SELECT COUNT(*) FROM notifications`); got != 0 {
				t.Fatalf("ineligible notification rows = %d, want 0", got)
			}
		})
	}
}

func TestOnlineFriendNotificationDoesNotRequireRecipientToBeOnline(t *testing.T) {
	db := newOnlineFriendNotificationFixture(t, `{"privacy":{"shareOnlineUpdates":true}}`, `{"notifications":{"onlineFriendNotifications":true}}`)
	if _, err := db.Conn.Exec(`UPDATE users SET status='offline' WHERE id='online-recipient'`); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteNotificationRepo(wrapForRepo(db)).(OnlineFriendNotificationRepository)
	created, err := repo.CreateIfOnlineFriendEligible(context.Background(), "online-actor", "online-recipient", newOnlineFriendNotice())
	if err != nil || created == nil {
		t.Fatalf("offline recipient result = %#v, %v; want committed notification", created, err)
	}
}

func TestOnlineFriendNotificationPostgresLockConflictRollsBackAndRechecks(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	for _, tc := range []struct {
		name   string
		update string
	}{
		{name: "friendship revoked", update: `UPDATE friendships SET status='pending' WHERE id='online-friendship'`},
		{name: "recipient opted out", update: `UPDATE user_preferences SET data='{"notifications":{"onlineFriendNotifications":false}}' WHERE user_id='online-recipient'`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := newOnlineFriendNotificationFixture(t, `{"privacy":{"shareOnlineUpdates":true}}`, `{"notifications":{"onlineFriendNotifications":true}}`)
			raw := database.RawDB(db.Conn)
			writerTx, err := raw.BeginTx(context.Background(), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer writerTx.Rollback()
			if _, err := writerTx.ExecContext(context.Background(), tc.update); err != nil {
				t.Fatal(err)
			}

			repo := NewSQLiteNotificationRepo(wrapForRepo(db)).(OnlineFriendNotificationRepository)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			created, err := repo.CreateIfOnlineFriendEligible(ctx, "online-actor", "online-recipient", newOnlineFriendNotice())
			var lockErr *pgconn.PgError
			if created != nil || !errors.As(err, &lockErr) || lockErr.Code != "55P03" {
				t.Fatalf("write during eligibility mutation = %#v, %v; want clean NOWAIT conflict", created, err)
			}
			if got := countRows(t, db, `SELECT COUNT(*) FROM notifications`); got != 0 {
				t.Fatalf("conflicted attempt left %d notifications", got)
			}
			if err := writerTx.Commit(); err != nil {
				t.Fatal(err)
			}
			created, err = repo.CreateIfOnlineFriendEligible(context.Background(), "online-actor", "online-recipient", newOnlineFriendNotice())
			if err != nil || created != nil {
				t.Fatalf("retry after eligibility change = %#v, %v; want no notification", created, err)
			}
			if got := countRows(t, db, `SELECT COUNT(*) FROM notifications`); got != 0 {
				t.Fatalf("post-revocation retry left %d notifications", got)
			}
		})
	}
}
