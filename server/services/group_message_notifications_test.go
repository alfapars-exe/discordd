package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"testing"
)

type groupIncomingFixture struct {
	groupReadFixture
	fail          bool
	deliveryCalls int
}

func (f *groupIncomingFixture) DeliverCommittedGroupNotifications(_ context.Context, g, m string, deliver func(*models.Notification)) error {
	f.deliveryCalls++
	if f.fail {
		return errors.New("postcommit lookup unavailable")
	}
	actor := "sender"
	deliver(&models.Notification{ID: "owned-row", UserID: "reader", ActorID: &actor, MessageID: &m, GroupDMChannelID: &g})
	return nil
}

type groupInboxSummaryFixture struct {
	testutil.MockNotificationRepo
	t *testing.T
}

func (f *groupInboxSummaryFixture) CreateReactionIfAbsent(context.Context, *models.Notification, string) (bool, error) {
	f.t.Fatal("unexpected reaction write during inbox refresh")
	return false, nil
}

func (*groupInboxSummaryFixture) CountUnreadSummary(context.Context, string) (models.NotificationUnreadCounts, error) {
	return models.NotificationUnreadCounts{UnreadCount: 11, BadgeUnreadCount: 2}, nil
}
func TestGroupIncomingNotificationPostcommitPushAndBoundedRefresh(t *testing.T) {
	ctx := context.Background()
	f := &groupIncomingFixture{groupReadFixture: groupReadFixture{member: true}}
	hub := &testutil.MockBroadcaster{}
	events := []ws.Event{}
	hub.BroadcastToUserFn = func(owner string, event ws.Event) {
		if event.Op == ws.OpNotificationCreate {
			n := event.Data.(*models.Notification)
			if owner != "reader" || n.GroupDMChannelID == nil || *n.GroupDMChannelID != "group" || n.MessageID == nil || *n.MessageID != "message" {
				t.Fatalf("wrong owned source %+v", n)
			}
		}
		events = append(events, event)
	}
	svc := NewGroupDMService(f, nil, nil, hub, "", "", "", nil, "", &groupInboxSummaryFixture{t: t}, nil, nil, f)
	if err := svc.BroadcastMessage(ctx, &models.GroupDMMessage{GroupID: "group", ID: "message", UserID: "sender"}); err != nil {
		t.Fatal(err)
	}
	foundCreate, foundRefresh := false, false
	for _, event := range events {
		if event.Op == ws.OpNotificationCreate {
			foundCreate = true
		}
		if event.Op == ws.OpNotificationRead {
			data := event.Data.(map[string]any)
			if data["all"] != false || data["refresh_required"] != true || data["unread_count"] != 11 || data["badge_unread_count"] != 2 || len(data["ids"].([]string)) != 0 {
				t.Fatalf("unsafe refresh %+v", data)
			}
			foundRefresh = true
		}
	}
	if !foundCreate || !foundRefresh {
		t.Fatal("missing persisted source push or authoritative refresh")
	}
	f.fail = true
	events = nil
	if err := svc.BroadcastMessage(ctx, &models.GroupDMMessage{GroupID: "group", ID: "message", UserID: "sender"}); err != nil {
		t.Fatal("postcommit event failure invited message retry")
	}
	for _, event := range events {
		if event.Op == ws.OpNotificationCreate {
			t.Fatal("fabricated notification on failed lookup")
		}
	}
}

func TestGroupIncomingNotificationExplicitlyDisabledDelivery(t *testing.T) {
	fixture := &groupIncomingFixture{groupReadFixture: groupReadFixture{member: true}}
	hub := &testutil.MockBroadcaster{BroadcastToUserFn: func(_ string, event ws.Event) {
		if event.Op == ws.OpNotificationCreate {
			t.Fatal("disabled integration pushed notification")
		}
	}}
	service := NewGroupDMService(fixture, nil, nil, hub, "", "", "", nil, "", nil, nil, nil, nil)
	if err := service.BroadcastMessage(context.Background(), &models.GroupDMMessage{GroupID: "group", ID: "message", UserID: "sender"}); err != nil {
		t.Fatal(err)
	}
	if fixture.deliveryCalls != 0 {
		t.Fatal("disabled integration rediscovered repository capability")
	}
}
