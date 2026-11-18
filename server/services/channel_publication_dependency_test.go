package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"testing"
)

func TestChannelAndThreadPublicationUseDeclaredFreshPermissionSource(t *testing.T) {
	for _, kind := range []models.ChannelType{models.ChannelTypeText, models.ChannelTypeThread} {
		t.Run(string(kind), func(t *testing.T) {
			fixture := permFixture{serverID: "server", channelID: "channel", roles: map[string][]models.Role{"viewer": {{ID: "role", ServerID: "server", Permissions: models.PermViewChannel | models.PermReadMessages}}}}
			resolver := fixture.newService(t, &bulkRepoCounter{})
			ctx := context.Background()
			if _, err := resolver.ResolveChannelPermissionsBulk(ctx, "channel", []string{"viewer"}); err != nil {
				t.Fatal(err)
			}
			fixture.roles["viewer"] = []models.Role{{ID: "role", ServerID: "server", Permissions: models.PermConnectVoice}}
			pushes := 0
			hub := &testutil.MockBroadcastAndOnline{GetOnlineUserIDsForServerFn: func(string) []string { return []string{"viewer"} }, MockBroadcaster: testutil.MockBroadcaster{BroadcastToUsersFn: func(ids []string, event ws.Event) {
				pushes++
				if len(ids) != 1 || ids[0] != "viewer" || event.Op != ws.OpChannelUpdate {
					t.Fatal("publication payload/recipient lost")
				}
			}}}
			channel := &models.Channel{ID: "channel", ServerID: "server", Type: kind}
			broadcastVisibleChannel(ctx, hub, resolver, resolver, channel, ws.OpChannelUpdate)
			if pushes != 0 {
				t.Fatal("fresh publication exposed revoked channel")
			}
			broadcastVisibleChannel(ctx, hub, resolver, &voicePermissionChoice{err: errors.New("fresh unavailable")}, channel, ws.OpChannelUpdate)
			if pushes != 0 {
				t.Fatal("fresh error fell back to stale grant")
			}
			broadcastVisibleChannel(ctx, hub, resolver, nil, channel, ws.OpChannelUpdate)
			if pushes != 1 {
				t.Fatal("standalone choice rediscovered fresh provider")
			}
		})
	}
}
