package services

import (
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

func TestNotificationReadLargeAcknowledgementHasBoundedWireIDs(t *testing.T) {
	ids := make([]string, 600)
	for i := range ids {
		ids[i] = fmt.Sprintf("source-%d", i)
	}
	var got ws.Event
	hub := &testutil.MockBroadcaster{BroadcastToUserFn: func(owner string, event ws.Event) {
		if owner != "owner" {
			t.Fatal("wrong audience")
		}
		got = event
	}}
	broadcastNotificationRead(hub, "owner", ids, false, 3, 1)
	data := got.Data.(map[string]any)
	if got.Op != ws.OpNotificationRead || len(data["ids"].([]string)) != 512 || data["refresh_required"] != true || data["unread_count"] != 3 || data["badge_unread_count"] != 1 {
		t.Fatalf("incorrect bounded acknowledgement: %v", data)
	}
	if len(ids) != 600 {
		t.Fatal("caller IDs modified")
	}
	broadcastNotificationRead(hub, "owner", ids[:2], false, 3, 1)
	if _, exists := got.Data.(map[string]any)["refresh_required"]; exists {
		t.Fatal("small ack requested unnecessary refresh")
	}
}
