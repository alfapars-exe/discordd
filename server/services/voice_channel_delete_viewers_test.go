package services

import (
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestDeleteVoiceChannelPreservesUnrelatedViewerBookkeeping(t *testing.T) {
	s := &voiceService{
		states: map[string]*models.VoiceState{
			"departing": {UserID: "departing", ServerID: "server", ChannelID: "deleted"},
			"remaining": {UserID: "remaining", ServerID: "server", ChannelID: "other"},
		},
		screenShareViewers: map[string]map[string]bool{
			"departing":     {"watcher": true},
			"mixed":         {"departing": false, "remaining": true},
			"only-departed": {"departing": false},
			"orphan":        {"unrelated": true},
			"empty":         {},
		},
	}

	removed := s.detachVoiceChannel("server", "deleted")
	if len(removed) != 1 || removed[0].userID != "departing" {
		t.Fatalf("removed sessions = %#v", removed)
	}
	want := map[string]map[string]bool{
		"mixed":  {"remaining": true},
		"orphan": {"unrelated": true},
		"empty":  {},
	}
	if !reflect.DeepEqual(s.screenShareViewers, want) {
		t.Fatalf("viewer bookkeeping = %#v, want %#v", s.screenShareViewers, want)
	}
	if s.channelDeleteEpoch != 1 || s.voiceRevision != 1 {
		t.Fatalf("epoch/revision = %d/%d, want 1/1", s.channelDeleteEpoch, s.voiceRevision)
	}
	if _, ok := s.states["remaining"]; !ok {
		t.Fatal("unrelated occupant was removed")
	}
}
