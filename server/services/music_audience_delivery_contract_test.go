package services

import (
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

func TestMusicAudiencePublisherDeliveryContract(t *testing.T) {
	tests := []struct {
		name                         string
		final, fatal, stopping       bool
		removed, replaced, delivered bool
	}{
		{name: "active", delivered: true},
		{name: "stopping", stopping: true},
		{name: "fatal-stopping", fatal: true, stopping: true, delivered: true},
		{name: "final-current", final: true, stopping: true, delivered: true},
		{name: "final-removed", final: true, removed: true, delivered: true},
		{name: "final-replaced", final: true, replaced: true},
		{name: "active-removed", removed: true},
		{name: "fatal-removed", fatal: true, removed: true},
		{name: "active-replaced", replaced: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestMusicBotService("ch", "srv")
			old := s.bots["ch"]
			old.stopping.Store(tc.stopping)
			if tc.removed {
				delete(s.bots, "ch")
			}
			if tc.replaced {
				s.bots["ch"] = &botInstance{channelID: "ch", serverID: "srv"}
			}
			var recipients []string
			s.hub = &testutil.MockBroadcaster{BroadcastToUsersFn: func(ids []string, event ws.Event) {
				recipients = append(recipients, ids...)
				if event.ServerID != "srv" || event.Op != "music_bot_state" {
					t.Errorf("wrong event scope: %+v", event)
				}
			}}
			publisher := &musicPublisher{bot: old, final: tc.final, fatal: tc.fatal}
			sent := s.broadcastMusicAudience("srv", "ch", ws.Event{Op: "music_bot_state"}, publisher)
			if sent != tc.delivered {
				t.Fatalf("sent=%v, want %v", sent, tc.delivered)
			}
			if tc.delivered && !reflect.DeepEqual(recipients, []string{"listener"}) {
				t.Fatalf("wrong recipients: %v", recipients)
			}
			if !tc.delivered && len(recipients) != 0 {
				t.Fatalf("retired publisher delivered: %v", recipients)
			}
		})
	}
}

func TestMusicAudiencePublisherReplacementPreservesPartialDeliveryAndStopsLookups(t *testing.T) {
	for _, final := range []bool{false, true} {
		t.Run(map[bool]string{false: "active", true: "final"}[final], func(t *testing.T) {
			s := newTestMusicBotService("ch", "srv")
			old := s.bots["ch"]
			if final {
				delete(s.bots, "ch")
			}
			voice := s.audience.Voice.(*musicAudienceFixtureVoice)
			first := *voice.GetUserVoiceState("listener")
			voice.candidates = []models.VoiceState{first}
			for _, user := range []string{"later", "never"} {
				state := first
				state.UserID = user
				voice.states[user] = state
				voice.candidates = append(voice.candidates, state)
			}
			var checked, recipients []string
			s.audience.FreshPermissions.(*musicAudienceFixturePerms).during = func(user string) {
				checked = append(checked, user)
				if user == "later" {
					s.mu.Lock()
					s.bots["ch"] = &botInstance{channelID: "ch", serverID: "srv"}
					s.mu.Unlock()
				}
			}
			s.hub = &testutil.MockBroadcaster{BroadcastToUsersFn: func(ids []string, _ ws.Event) {
				recipients = append(recipients, ids...)
			}}
			if !s.broadcastMusicAudience("srv", "ch", ws.Event{Op: "music_bot_state"}, &musicPublisher{bot: old, final: final}) {
				t.Fatal("lost successful first delivery after publisher replacement")
			}
			if !reflect.DeepEqual(recipients, []string{"listener"}) || !reflect.DeepEqual(checked, []string{"listener", "later"}) {
				t.Fatalf("wrong retirement boundary: recipients=%v checked=%v", recipients, checked)
			}
		})
	}
}
