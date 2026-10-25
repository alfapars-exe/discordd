package ws

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/argeinfina/hichat/models"
)

type voiceSnapshotProviderStub struct {
	states   []models.VoiceState
	viewers  map[string][]string
	epoch    string
	revision uint64
}

func (s voiceSnapshotProviderStub) GetAllVoiceStates() []models.VoiceState { return s.states }
func (s voiceSnapshotProviderStub) GetAllScreenShareViewers() map[string][]string {
	return s.viewers
}
func (s voiceSnapshotProviderStub) GetVoiceStateSnapshot() ([]models.VoiceState, map[string][]string, string, uint64) {
	return s.states, s.viewers, s.epoch, s.revision
}

type voiceSnapshotFilterStub struct {
	wantViewer string
	wantServer []string
	states     []models.VoiceState
	err        error
}

func (s voiceSnapshotFilterStub) FilterVisibleVoiceStates(_ context.Context, viewerID string, serverIDs []string, _ []models.VoiceState) ([]models.VoiceState, error) {
	if viewerID != s.wantViewer {
		return nil, nil
	}
	if len(serverIDs) != len(s.wantServer) {
		return nil, nil
	}
	for i := range serverIDs {
		if serverIDs[i] != s.wantServer[i] {
			return nil, nil
		}
	}
	return s.states, s.err
}

func TestSendVoiceStatesSyncFiltersBeforeAddingViewerIDs(t *testing.T) {
	h := &Handler{
		voiceStatesProvider: voiceSnapshotProviderStub{
			epoch:    "epoch-a",
			revision: 17,
			states: []models.VoiceState{
				{UserID: "visible", ServerID: "server-a", ChannelID: "voice-a", IsStreaming: true},
				{UserID: "hidden", ServerID: "server-a", ChannelID: "private", IsStreaming: true},
				{UserID: "foreign", ServerID: "server-b", ChannelID: "voice-b", IsStreaming: true},
			},
			viewers: map[string][]string{
				"visible": {"viewer-visible"},
				"hidden":  {"viewer-hidden"},
			},
		},
		voiceStateFilter: voiceSnapshotFilterStub{
			wantViewer: "viewer",
			wantServer: []string{"server-a"},
			states: []models.VoiceState{
				{UserID: "visible", ServerID: "server-a", ChannelID: "voice-a", IsStreaming: true},
			},
		},
	}
	client := &Client{userID: "viewer", send: make(chan []byte, 1)}
	h.sendVoiceStatesSync(context.Background(), client, []string{"server-a"})

	var event Event
	if err := json.Unmarshal(<-client.send, &event); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	if event.Op != OpVoiceStatesSync {
		t.Fatalf("op = %q, want %q", event.Op, OpVoiceStatesSync)
	}
	var data VoiceStatesSyncData
	encoded, _ := json.Marshal(event.Data)
	if err := json.Unmarshal(encoded, &data); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if len(data.States) != 1 || data.States[0].UserID != "visible" {
		t.Fatalf("snapshot states = %+v, want only authorized state", data.States)
	}
	if len(data.States[0].ScreenShareViewers) != 1 || data.States[0].ScreenShareViewers[0] != "viewer-visible" {
		t.Fatalf("visible stream viewers = %v, want visible viewer only", data.States[0].ScreenShareViewers)
	}
	if data.VoiceEpoch != "epoch-a" || data.VoiceRevision != 17 {
		t.Fatalf("snapshot fence = (%q,%d), want (epoch-a,17)", data.VoiceEpoch, data.VoiceRevision)
	}
}

func TestSendVoiceStatesSyncFailsClosedWithoutVisibilityFilter(t *testing.T) {
	h := &Handler{voiceStatesProvider: voiceSnapshotProviderStub{
		states: []models.VoiceState{{UserID: "secret", ServerID: "server", ChannelID: "private"}},
	}}
	client := &Client{userID: "viewer", send: make(chan []byte, 1)}
	h.sendVoiceStatesSync(context.Background(), client, []string{"server"})

	var event Event
	if err := json.Unmarshal(<-client.send, &event); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	var data VoiceStatesSyncData
	encoded, _ := json.Marshal(event.Data)
	if err := json.Unmarshal(encoded, &data); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if len(data.States) != 0 {
		t.Fatalf("snapshot without filter leaked states: %+v", data.States)
	}
}
