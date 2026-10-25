package services

import (
	"encoding/json"
	"testing"

	"github.com/argeinfina/hichat/ws"
)

// Empty authoritative sets must stay arrays on the wire. JSON null is not
// iterable by the client and used to break the stream-stop cleanup handler.
func TestVoiceViewerSnapshotEmptySetWireArray(t *testing.T) {
	for _, pointer := range []bool{false, true} {
		for _, ids := range [][]string{nil, {}} {
			payload := ws.ScreenShareViewerUpdateData{ChannelID: "channel", ViewerUserIDs: ids}
			var data any = payload
			if pointer {
				data = &payload
			}
			_, snapshot, ok := snapshotVoiceEvent(ws.Event{Op: ws.OpScreenShareViewerUpdate, Data: data})
			if !ok {
				t.Fatal("snapshot rejected viewer event")
			}
			wire, err := json.Marshal(snapshot.Data)
			if err != nil {
				t.Fatal(err)
			}
			var decoded map[string]json.RawMessage
			if err := json.Unmarshal(wire, &decoded); err != nil {
				t.Fatal(err)
			}
			if string(decoded["viewer_user_ids"]) != "[]" {
				t.Fatalf("pointer=%v: expected empty array, got %s", pointer, wire)
			}
		}
	}
}
