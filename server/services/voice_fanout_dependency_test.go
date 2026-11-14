package services

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
	"time"
)

func TestVoiceFanoutUsesExplicitAudienceAndMissingDependenciesDrop(t *testing.T) {
	for _, mode := range []string{"selected", "missing online", "missing members", "disabled"} {
		t.Run(mode, func(t *testing.T) {
			output := &fanoutTestHub{online: []string{"implicit"}}
			selectedOnline := &fanoutTestHub{online: []string{"explicit", "not-member"}}
			selectedMembers := fanoutTestMembers{ids: []string{"explicit"}}
			dependencies := VoiceFanoutDependencies{Online: selectedOnline, Members: selectedMembers}
			if mode == "missing online" || mode == "disabled" {
				dependencies.Online = nil
			}
			if mode == "missing members" || mode == "disabled" {
				dependencies.Members = nil
			}
			queries, pushes := 0, 0
			output.BroadcastToUsersFn = func(ids []string, _ ws.Event) {
				pushes++
				if !reflect.DeepEqual(ids, []string{"explicit"}) {
					t.Fatalf("audience=%v", ids)
				}
			}
			resolver := &testutil.MockChannelPermResolver{ResolveChannelPermissionsBulkFn: func(_ context.Context, channel string, ids []string) (map[string]models.Permission, error) {
				queries++
				if channel != "channel" || !reflect.DeepEqual(ids, []string{"explicit"}) {
					t.Fatalf("permission scope=%s %v", channel, ids)
				}
				return map[string]models.Permission{"explicit": models.PermViewChannel | models.PermReadMessages}, nil
			}}
			service := NewVoiceService(fanoutTestChannels{channel: &models.Channel{ID: "channel", ServerID: "server", Type: models.ChannelTypeVoice}}, nil, resolver, output, nil, fanoutTestMembers{ids: []string{"implicit"}}, nil, nil, nil, nil, VoiceRuntimeDependencies{Fanout: dependencies}).(*voiceService)
			t.Cleanup(service.ShutdownVoiceStateFanout)
			service.voiceFanout.deliver([]voiceStateFanoutEvent{{queuedAt: time.Now(), serverID: "server", channelID: "channel", event: ws.Event{}}}, map[string][]string{})
			if mode == "selected" {
				if pushes != 1 || queries != 1 || service.voiceFanout.dropped() != 0 {
					t.Fatal("explicit audience was not delivered")
				}
			} else {
				if pushes != 0 || queries != 0 || service.voiceFanout.dropped() != 1 {
					t.Fatal("missing dependency rediscovered legacy audience")
				}
			}
		})
	}
}
