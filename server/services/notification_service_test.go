package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

func TestNotificationService_List_ClampsLimitAndComputesHasMore(t *testing.T) {
	var gotLimit int
	repo := &testutil.MockNotificationRepo{
		ListFn: func(_ context.Context, userID, before string, unreadOnly bool, limit int) ([]models.Notification, error) {
			gotLimit = limit
			out := make([]models.Notification, limit) // repo returns limit+1 rows → has_more
			for i := range out {
				out[i] = models.Notification{ID: "n" + string(rune('a'+i)), UserID: userID}
			}
			return out, nil
		},
	}
	svc := NewNotificationService(repo, &testutil.MockBroadcaster{})

	page, err := svc.List(context.Background(), "u1", "", false, 2)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if gotLimit != 3 {
		t.Errorf("repo limit = %d, want limit+1 = 3", gotLimit)
	}
	if !page.HasMore {
		t.Error("has_more = false, want true when the repo returned limit+1 rows")
	}
	if len(page.Notifications) != 2 {
		t.Errorf("page size = %d, want 2", len(page.Notifications))
	}

	// Out-of-range limit falls back to the default.
	if _, err := svc.List(context.Background(), "u1", "", false, 0); err != nil {
		t.Fatalf("List(limit 0): %v", err)
	}
	if gotLimit != NotificationPageDefault+1 {
		t.Errorf("repo limit for limit=0 = %d, want default+1 = %d", gotLimit, NotificationPageDefault+1)
	}
}

func TestNotificationService_MarkRead_NotFoundAndBroadcast(t *testing.T) {
	var events []ws.Event
	hub := &testutil.MockBroadcaster{
		BroadcastToUserFn: func(userID string, e ws.Event) {
			if userID != "u1" {
				t.Errorf("notification_read sent to %q, want the reader u1", userID)
			}
			events = append(events, e)
		},
	}
	repo := &testutil.MockNotificationRepo{
		MarkReadFn: func(_ context.Context, userID, id string) (bool, error) {
			return id == "owned", nil
		},
		CountUnreadFn: func(_ context.Context, _ string) (int, error) { return 4, nil },
	}
	svc := NewNotificationService(repo, hub)

	err := svc.MarkRead(context.Background(), "u1", "someone-elses")
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("MarkRead(not owned) err = %v, want ErrNotFound", err)
	}
	if len(events) != 0 {
		t.Fatalf("a failed mark-read still broadcast %d event(s)", len(events))
	}

	if err := svc.MarkRead(context.Background(), "u1", "owned"); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if len(events) != 1 || events[0].Op != ws.OpNotificationRead {
		t.Fatalf("events = %+v, want one notification_read", events)
	}
	data := events[0].Data.(map[string]any)
	if ids := data["ids"].([]string); len(ids) != 1 || ids[0] != "owned" {
		t.Errorf("ids = %v, want [owned]", ids)
	}
	if data["all"] != false || data["unread_count"] != 4 {
		t.Errorf("data = %v, want all=false unread_count=4", data)
	}
}

func TestNotificationService_MarkAllRead_BroadcastsZero(t *testing.T) {
	var got ws.Event
	hub := &testutil.MockBroadcaster{BroadcastToUserFn: func(_ string, e ws.Event) { got = e }}
	repo := &testutil.MockNotificationRepo{
		MarkAllReadFn: func(_ context.Context, _ string) (int64, error) { return 7, nil },
		CountUnreadFn: func(_ context.Context, _ string) (int, error) {
			t.Fatal("MarkAllRead must not re-count: the remaining unread count is 0 by construction")
			return 0, nil
		},
	}
	svc := NewNotificationService(repo, hub)

	marked, err := svc.MarkAllRead(context.Background(), "u1")
	if err != nil {
		t.Fatalf("MarkAllRead: %v", err)
	}
	if marked != 7 {
		t.Errorf("marked = %d, want 7", marked)
	}
	data := got.Data.(map[string]any)
	if got.Op != ws.OpNotificationRead || data["all"] != true || data["unread_count"] != 0 {
		t.Errorf("event = %+v, want notification_read all=true unread_count=0", got)
	}
}

func TestBroadcastNotificationCreate_TargetsNotificationOwner(t *testing.T) {
	var toUser string
	var ev ws.Event
	hub := &testutil.MockBroadcaster{BroadcastToUserFn: func(u string, e ws.Event) { toUser, ev = u, e }}
	n := &models.Notification{ID: "n1", UserID: "target", Kind: models.NotificationKindMention}

	broadcastNotificationCreate(hub, n)

	if toUser != "target" {
		t.Errorf("sent to %q, want target", toUser)
	}
	if ev.Op != ws.OpNotificationCreate || ev.Data != n {
		t.Errorf("event = %+v, want notification_create carrying the row", ev)
	}
}
