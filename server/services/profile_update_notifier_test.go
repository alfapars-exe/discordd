package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type profileUpdatePrefsStub struct{ share *bool }

func (s profileUpdatePrefsStub) Get(context.Context, string) (*models.UserPreferences, error) {
	privacy := map[string]any{}
	if s.share != nil {
		privacy["shareProfileUpdates"] = *s.share
	}
	data, _ := json.Marshal(map[string]any{"privacy": privacy})
	return &models.UserPreferences{Data: data}, nil
}

type profileUpdateFriendsStub struct{ friends []models.FriendshipWithUser }

func (s profileUpdateFriendsStub) ListFriends(context.Context, string) ([]models.FriendshipWithUser, error) {
	return s.friends, nil
}

func boolPtr(v bool) *bool { return &v }

type profileUpdatePreferenceMap map[string]*models.UserPreferences

func (s profileUpdatePreferenceMap) Get(_ context.Context, id string) (*models.UserPreferences, error) {
	return s[id], nil
}

func TestProfileUpdateNotifierInvalidPreferencesDoNotPublish(t *testing.T) {
	for _, recipient := range []bool{false, true} {
		for _, invalid := range []*models.UserPreferences{nil, {Data: json.RawMessage(`null`)}, {Data: json.RawMessage(`[]`)}, {Data: json.RawMessage(`{"privacy":`)}} {
			prefs := profileUpdatePreferenceMap{
				"actor":  {Data: json.RawMessage(`{}`)},
				"friend": {Data: json.RawMessage(`{}`)},
			}
			if recipient {
				prefs["friend"] = invalid
			} else {
				prefs["actor"] = invalid
			}
			n := NewProfileUpdateNotifier(prefs, profileUpdateFriendsStub{friends: []models.FriendshipWithUser{{UserID: "friend"}}},
				&testutil.MockNotificationRepo{CreateFn: func(context.Context, *models.Notification) error {
					t.Fatal("invalid preference state must not publish")
					return nil
				}}, &testutil.MockBroadcaster{})
			if err := n.NotifyProfileUpdated(context.Background(), "actor"); err == nil {
				t.Fatalf("recipient=%v invalid=%+v: expected error", recipient, invalid)
			}
		}
	}
}

func TestProfileUpdateNotifierPreference(t *testing.T) {
	for _, tt := range []struct {
		name  string
		share *bool
		want  int
	}{
		{name: "missing preference defaults on", want: 2},
		{name: "explicit on", share: boolPtr(true), want: 2},
		{name: "explicit off suppresses new notifications", share: boolPtr(false), want: 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var rows []*models.Notification
			var pushed []string
			repo := &testutil.MockNotificationRepo{CreateFn: func(_ context.Context, n *models.Notification) error {
				rows = append(rows, n)
				n.ID = "notification-id"
				return nil
			}}
			hub := &testutil.MockBroadcaster{BroadcastToUserFn: func(userID string, event ws.Event) {
				if event.Op != ws.OpNotificationCreate {
					t.Fatalf("event op = %v, want notification_create", event.Op)
				}
				pushed = append(pushed, userID)
			}}
			notifier := NewProfileUpdateNotifier(
				profileUpdatePrefsStub{share: tt.share},
				profileUpdateFriendsStub{friends: []models.FriendshipWithUser{{UserID: "friend-1"}, {UserID: "friend-2"}}},
				repo,
				hub,
			)
			if err := notifier.NotifyProfileUpdated(context.Background(), "actor"); err != nil {
				t.Fatalf("NotifyProfileUpdated: %v", err)
			}
			if len(rows) != tt.want || len(pushed) != tt.want {
				t.Fatalf("created=%d pushed=%d, want %d", len(rows), len(pushed), tt.want)
			}
			for _, row := range rows {
				if row.Kind != models.NotificationKindSystem || row.ActorID == nil || *row.ActorID != "actor" {
					t.Fatalf("notification = %+v", row)
				}
			}
		})
	}
}
