package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type reactionDeliveryRepo struct {
	testutil.MockNotificationRepo
	created bool
	calls   int
}

func (r *reactionDeliveryRepo) CreateReactionIfAbsent(_ context.Context, n *models.Notification, emoji string) (bool, error) {
	r.calls++
	n.ID = "notification-1"
	return r.created, nil
}

type reactionPrefsStub struct{ mode string }

func (p reactionPrefsStub) Get(context.Context, string) (*models.UserPreferences, error) {
	data, _ := json.Marshal(map[string]any{"notifications": map[string]string{"reactionMode": p.mode}})
	return &models.UserPreferences{Data: data}, nil
}

func TestReactionNotificationDelivery(t *testing.T) {
	for _, tc := range []struct {
		name, mode, actor          string
		added, created             bool
		wantWrites, wantBroadcasts int
	}{
		{"direct excludes channels", "direct", "actor", true, true, 0, 0},
		{"all", "all", "actor", true, true, 1, 1},
		{"disabled", "none", "actor", true, true, 0, 0},
		{"removed", "all", "actor", false, true, 0, 0},
		{"self", "all", "author", true, true, 0, 0},
		{"duplicate", "all", "actor", true, false, 1, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &reactionDeliveryRepo{created: tc.created}
			broadcasts := 0
			hub := &testutil.MockBroadcastAndOnline{MockBroadcaster: testutil.MockBroadcaster{BroadcastToUserFn: func(userID string, event ws.Event) {
				broadcasts++
				n := event.Data.(*models.Notification)
				if userID != "author" || n.MessageID == nil || *n.MessageID != "message" {
					t.Fatal("wrong notification destination")
				}
			}}}
			svc := NewReactionService(
				&testutil.MockReactionRepo{ToggleFn: func(context.Context, string, string, string) (bool, error) { return tc.added, nil }},
				&testutil.MockMessageRepo{GetByIDFn: func(context.Context, string) (*models.Message, error) {
					return &models.Message{ID: "message", UserID: "author", ChannelID: "channel"}, nil
				}},
				&testutil.MockChannelRepo{GetByIDFn: func(context.Context, string) (*models.Channel, error) {
					return &models.Channel{ID: "channel", ServerID: "server"}, nil
				}}, hub, readResolver(), nil,
			)
			svc.SetNotificationDelivery(repo, reactionPrefsStub{tc.mode}, nil)
			if err := svc.ToggleReaction(context.Background(), "server", "message", tc.actor, "👍"); err != nil {
				t.Fatal(err)
			}
			if repo.calls != tc.wantWrites || broadcasts != tc.wantBroadcasts {
				t.Fatalf("writes=%d broadcasts=%d; want %d/%d", repo.calls, broadcasts, tc.wantWrites, tc.wantBroadcasts)
			}
		})
	}
}

func TestReactionNotificationPrivatePreference(t *testing.T) {
	for _, mode := range []string{"all", "direct", "none"} {
		t.Run(mode, func(t *testing.T) {
			repo := &reactionDeliveryRepo{created: true}
			actor, message, channel := "actor", "message", "private"
			n := &models.Notification{UserID: "author", Kind: models.NotificationKindSystem, ActorID: &actor, MessageID: &message, DMChannelID: &channel}
			deliverReactionNotification(context.Background(), repo, reactionPrefsStub{mode}, nil, &testutil.MockBroadcastAndOnline{}, n, "👍", true)
			want := 1
			if mode == "none" {
				want = 0
			}
			if repo.calls != want {
				t.Fatalf("writes=%d, want %d", repo.calls, want)
			}
		})
	}
}
