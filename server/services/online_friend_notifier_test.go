package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type onlineFriendPrefsStub map[string]json.RawMessage

func (s onlineFriendPrefsStub) Get(_ context.Context, userID string) (*models.UserPreferences, error) {
	data, ok := s[userID]
	if !ok {
		data = json.RawMessage(`{}`)
	}
	return &models.UserPreferences{UserID: userID, Data: data}, nil
}

type onlineFriendPresenceStub []string

func (s onlineFriendPresenceStub) GetVisibleOnlineUserIDs() []string { return s }

type guardedOnlineNoticeRepo struct {
	*testutil.MockNotificationRepo
	eligible bool
}

func (r *guardedOnlineNoticeRepo) CreateIfOnlineFriendEligible(ctx context.Context, _, _ string, n *models.Notification) (*models.Notification, error) {
	if !r.eligible {
		return nil, nil
	}
	if err := r.Create(ctx, n); err != nil {
		return nil, err
	}
	return n, nil
}

func guardedOnlineNotices(create func(context.Context, *models.Notification) error) *guardedOnlineNoticeRepo {
	return &guardedOnlineNoticeRepo{MockNotificationRepo: &testutil.MockNotificationRepo{CreateFn: create}, eligible: true}
}

func TestOnlineFriendNotifierCreatesOnlyOptedInVisibleFriendNotifications(t *testing.T) {
	var created []*models.Notification
	var pushed []string
	displayName := "Actor Display"
	users := &testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: "actor_username", DisplayName: &displayName, Status: models.UserStatusOnline}, nil
	}}
	friends := &testutil.MockFriendshipRepo{
		ListFriendsFn: func(_ context.Context, id string) ([]models.FriendshipWithUser, error) {
			if id != "actor" {
				t.Fatalf("ListFriends actor = %q", id)
			}
			return []models.FriendshipWithUser{{UserID: "enabled", Username: "Enabled"}, {UserID: "default", Username: "Default"}}, nil
		},
		IsBlockedFn: func(_ context.Context, actor, recipient string) (bool, error) {
			if actor != "actor" {
				t.Fatalf("block check actor = %q", actor)
			}
			return false, nil
		},
	}
	notifier := NewOnlineFriendNotifier(
		users,
		onlineFriendPrefsStub{
			"actor":   json.RawMessage(`{"privacy":{"shareOnlineUpdates":true}}`),
			"enabled": json.RawMessage(`{"notifications":{"onlineFriendNotifications":true}}`),
		},
		friends,
		guardedOnlineNotices(func(_ context.Context, n *models.Notification) error {
			created = append(created, n)
			n.ID = "notice-1"
			return nil
		}),
		onlineFriendPresenceStub{"actor"},
		&testutil.MockBroadcaster{BroadcastToUserFn: func(userID string, event ws.Event) {
			if event.Op != ws.OpNotificationCreate {
				t.Fatalf("broadcast op = %q", event.Op)
			}
			pushed = append(pushed, userID)
		}},
	)

	if err := notifier.NotifyOnline(context.Background(), "actor"); err != nil {
		t.Fatalf("NotifyOnline: %v", err)
	}
	if len(created) != 1 || len(pushed) != 1 || pushed[0] != "enabled" {
		t.Fatalf("created=%d pushed=%v; want only opted-in friend", len(created), pushed)
	}
	n := created[0]
	if n.UserID != "enabled" || n.Kind != models.NotificationKindSystem || n.ActorID == nil || *n.ActorID != "actor" || n.ChannelID != nil || n.ServerID != nil || n.MessageID != nil || n.DMChannelID != nil {
		t.Fatalf("notification contains unexpected scope/data: %+v", n)
	}
	var payload map[string]string
	if err := json.Unmarshal(n.Payload, &payload); err != nil || payload["action"] != "friend_online" || payload["title"] == "" || payload["body"] != "Actor Display is now online." {
		t.Fatalf("payload = %s, err=%v", n.Payload, err)
	}
}

func TestOnlineFriendNotifierActorPrivacyAndPresenceFailClosed(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   models.UserStatus
		visible  bool
		actor    json.RawMessage
		wantRead int
	}{
		{name: "actor opted out", status: models.UserStatusOnline, visible: true, actor: json.RawMessage(`{"privacy":{"shareOnlineUpdates":false}}`), wantRead: 0},
		{name: "actor invisible", status: models.UserStatusOnline, visible: false, actor: json.RawMessage(`{}`), wantRead: 0},
		{name: "actor offline", status: models.UserStatusOffline, visible: true, actor: json.RawMessage(`{}`), wantRead: 0},
		{name: "missing actor key defaults on", status: models.UserStatusOnline, visible: true, actor: json.RawMessage(`{}`), wantRead: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			created := 0
			prefs := onlineFriendPrefsStub{
				"actor":  tc.actor,
				"friend": json.RawMessage(`{"notifications":{"onlineFriendNotifications":true}}`),
			}
			users := &testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
				return &models.User{ID: id, Status: tc.status}, nil
			}}
			friends := &testutil.MockFriendshipRepo{
				ListFriendsFn: func(context.Context, string) ([]models.FriendshipWithUser, error) {
					return []models.FriendshipWithUser{{UserID: "friend", Username: "Friend"}}, nil
				},
				IsBlockedFn: func(context.Context, string, string) (bool, error) { return false, nil },
			}
			onlineIDs := onlineFriendPresenceStub{}
			if tc.visible {
				onlineIDs = append(onlineIDs, "actor")
			}
			notifier := NewOnlineFriendNotifier(users, prefs, friends, guardedOnlineNotices(
				func(context.Context, *models.Notification) error { created++; return nil },
			), onlineIDs, &testutil.MockBroadcaster{})
			if err := notifier.NotifyOnline(context.Background(), "actor"); err != nil {
				t.Fatalf("NotifyOnline: %v", err)
			}
			if created != tc.wantRead {
				t.Fatalf("created = %d, want %d", created, tc.wantRead)
			}
		})
	}
}

func TestOnlineFriendNotifierBlocksAndDeduplicatesEpochs(t *testing.T) {
	var created []string
	users := &testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Status: models.UserStatusOnline}, nil
	}}
	friends := &testutil.MockFriendshipRepo{
		ListFriendsFn: func(context.Context, string) ([]models.FriendshipWithUser, error) {
			return []models.FriendshipWithUser{{UserID: "blocked", Username: "Blocked"}, {UserID: "friend", Username: "Friend"}}, nil
		},
		IsBlockedFn: func(_ context.Context, _, recipient string) (bool, error) { return recipient == "blocked", nil },
	}
	prefs := onlineFriendPrefsStub{
		"actor":  json.RawMessage(`{}`),
		"friend": json.RawMessage(`{"notifications":{"onlineFriendNotifications":true}}`),
	}
	notifier := NewOnlineFriendNotifier(users, prefs, friends, guardedOnlineNotices(
		func(_ context.Context, n *models.Notification) error { created = append(created, n.UserID); return nil },
	), onlineFriendPresenceStub{"actor"}, &testutil.MockBroadcaster{})

	for range 3 {
		if err := notifier.NotifyOnline(context.Background(), "actor"); err != nil {
			t.Fatalf("NotifyOnline: %v", err)
		}
	}
	if fmt.Sprint(created) != "[friend]" {
		t.Fatalf("first online epoch notifications = %v", created)
	}
	notifier.ObserveOffline("actor")
	if err := notifier.NotifyOnline(context.Background(), "actor"); err != nil {
		t.Fatalf("NotifyOnline after offline: %v", err)
	}
	if fmt.Sprint(created) != "[friend friend]" {
		t.Fatalf("new online epoch notifications = %v", created)
	}
}

func TestOnlineFriendNotifierRetriesFailedRecipientWithoutDuplicatingSuccess(t *testing.T) {
	var created []string
	failFirst := true
	users := &testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Status: models.UserStatusOnline}, nil
	}}
	friends := &testutil.MockFriendshipRepo{
		ListFriendsFn: func(context.Context, string) ([]models.FriendshipWithUser, error) {
			return []models.FriendshipWithUser{{UserID: "good", Username: "Good"}, {UserID: "retry", Username: "Retry"}}, nil
		},
		IsBlockedFn: func(context.Context, string, string) (bool, error) { return false, nil },
	}
	prefs := onlineFriendPrefsStub{
		"actor": json.RawMessage(`{}`),
		"good":  json.RawMessage(`{"notifications":{"onlineFriendNotifications":true}}`),
		"retry": json.RawMessage(`{"notifications":{"onlineFriendNotifications":true}}`),
	}
	notifier := NewOnlineFriendNotifier(users, prefs, friends, guardedOnlineNotices(
		func(_ context.Context, n *models.Notification) error {
			if n.UserID == "retry" && failFirst {
				return errors.New("temporary insert failure")
			}
			created = append(created, n.UserID)
			return nil
		},
	), onlineFriendPresenceStub{"actor"}, &testutil.MockBroadcaster{})

	if err := notifier.NotifyOnline(context.Background(), "actor"); err == nil {
		t.Fatal("expected create failure")
	}
	failFirst = false
	if err := notifier.NotifyOnline(context.Background(), "actor"); err != nil {
		t.Fatalf("retry NotifyOnline: %v", err)
	}
	if fmt.Sprint(created) != "[good retry]" {
		t.Fatalf("created after retry = %v; want one each", created)
	}
}

func TestOnlineFriendNotifierDoesNotBroadcastWhenGuardedWriteFindsRevokedEdge(t *testing.T) {
	created, broadcast := 0, 0
	users := &testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Status: models.UserStatusOnline}, nil
	}}
	friends := &testutil.MockFriendshipRepo{
		ListFriendsFn: func(context.Context, string) ([]models.FriendshipWithUser, error) {
			// The candidate was accepted when enumerated; repository guard models
			// its removal immediately before the transactional insert.
			return []models.FriendshipWithUser{{UserID: "friend", Username: "Friend"}}, nil
		},
		IsBlockedFn: func(context.Context, string, string) (bool, error) { return false, nil },
	}
	writer := &guardedOnlineNoticeRepo{MockNotificationRepo: &testutil.MockNotificationRepo{
		CreateFn: func(context.Context, *models.Notification) error { created++; return nil },
	}, eligible: false}
	notifier := NewOnlineFriendNotifier(users, onlineFriendPrefsStub{
		"actor":  json.RawMessage(`{"privacy":{"shareOnlineUpdates":true}}`),
		"friend": json.RawMessage(`{"notifications":{"onlineFriendNotifications":true}}`),
	}, friends, writer, onlineFriendPresenceStub{"actor"}, &testutil.MockBroadcaster{
		BroadcastToUserFn: func(string, ws.Event) { broadcast++ },
	})
	if err := notifier.NotifyOnline(context.Background(), "actor"); err != nil {
		t.Fatalf("NotifyOnline: %v", err)
	}
	if created != 0 || broadcast != 0 {
		t.Fatalf("created=%d broadcast=%d, want no notification when live edge was revoked", created, broadcast)
	}
}
