package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestOnlineFriendCandidatesBatchBothRelationshipDirections(t *testing.T) {
	db := newOnlineFriendNotificationFixture(t, `{}`, `{"notifications":{"onlineFriendNotifications":true}}`)
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash)VALUES('reverse-recipient','reversefriend','x');`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO friendships(id,user_id,friend_id,status)VALUES('reverse-friend','reverse-recipient','online-actor','accepted')`); err != nil {
		t.Fatal(err)
	}
	r := NewSQLiteNotificationRepo(db.Conn)
	bulk := r.(interface {
		ListOnlineFriendCandidates(context.Context, string) ([]OnlineFriendCandidate, error)
	})
	rows, err := bulk.ListOnlineFriendCandidates(context.Background(), "online-actor")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("candidates=%+v", rows)
	}
	seen := map[string]*models.UserPreferences{}
	for _, row := range rows {
		seen[row.UserID] = row.Preferences
		if row.Blocked {
			t.Fatal("unexpected block")
		}
	}
	if seen["reverse-recipient"] == nil || string(seen["reverse-recipient"].Data) != "{}" {
		t.Fatal("missing default preferences")
	}
	if seen["online-recipient"] == nil {
		t.Fatal("missing forward friend")
	}
}
