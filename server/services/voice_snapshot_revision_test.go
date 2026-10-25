package services

import (
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestVoiceStateSnapshotCapturesStateViewersAndRevisionTogether(t *testing.T) {
	service := &voiceService{
		states: map[string]*models.VoiceState{
			"streamer": {UserID: "streamer", ServerID: "server", ChannelID: "voice", IsStreaming: true},
		},
		screenShareViewers: map[string]map[string]bool{
			"streamer": {"viewer": true},
		},
		voiceEpoch:    "epoch-test",
		voiceRevision: 23,
	}

	states, viewers, epoch, revision := service.GetVoiceStateSnapshot()
	if epoch != "epoch-test" || revision != 23 {
		t.Fatalf("snapshot fence = (%q,%d), want (epoch-test,23)", epoch, revision)
	}
	if len(states) != 1 || states[0].UserID != "streamer" || !states[0].IsStreaming {
		t.Fatalf("snapshot states = %+v, want the streaming user", states)
	}
	if got := viewers["streamer"]; len(got) != 1 || got[0] != "viewer" {
		t.Fatalf("snapshot viewers = %v, want [viewer]", got)
	}

	// Returned slices/maps are copies: callers filter them outside the voice
	// lock and must not be able to mutate the service's authoritative state.
	states[0].ChannelID = "mutated"
	viewers["streamer"][0] = "mutated"
	nextStates, nextViewers, _, _ := service.GetVoiceStateSnapshot()
	if nextStates[0].ChannelID != "voice" || nextViewers["streamer"][0] != "viewer" {
		t.Fatalf("snapshot escaped mutable state: states=%+v viewers=%v", nextStates, nextViewers)
	}
}
