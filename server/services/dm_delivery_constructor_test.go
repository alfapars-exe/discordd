package services

import (
	"database/sql"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"testing"
)

func TestDMConstructorSelectsDurableOrDirectPublicationBeforeUse(t *testing.T) {
	for _, durable := range []bool{false, true} {
		name := "direct"
		if durable {
			name = "durable"
		}
		t.Run(name, func(t *testing.T) {
			pushes := 0
			hub := &testutil.MockBroadcaster{BroadcastToUserFn: func(string, ws.Event) { pushes++ }}
			var db *sql.DB
			if durable {
				db = &sql.DB{}
			}
			service := NewDMService(nil, nil, nil, hub, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, db).(*dmService)
			channel := &models.DMChannel{User1ID: "first", User2ID: "second"}
			service.broadcastToBothUsers(channel, ws.Event{Op: ws.OpDMMessageCreate})
			service.hub.BroadcastToUser("first", ws.Event{Op: ws.OpDMMessageUpdate})
			want := 3
			if durable {
				want = 0
			}
			if pushes != want {
				t.Fatalf("direct DM publications=%d want%d", pushes, want)
			}
			service.hub.BroadcastToUser("first", ws.Event{Op: "fixture.non-durable"})
			if pushes != want+1 {
				t.Fatal("durable wrapper suppressed an unrelated event")
			}
		})
	}
}
