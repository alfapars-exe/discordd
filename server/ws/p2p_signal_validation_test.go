package ws

import (
	"strings"
	"testing"
	"time"
)

func validP2PDescription() P2PSignalData {
	return P2PSignalData{CallID: "call", Type: "offer", SDP: "v=0", MediaProtocol: 1, DescriptionID: "00000000-0000-4000-8000-000000000001", DescriptionRevision: 1, Capabilities: []string{"screen-audio-v1"}, Sources: []P2PMediaSource{{MID: "0", Source: "microphone"}, {MID: "1", Source: "screen-audio"}}}
}
func TestP2PSignalValidation(t *testing.T) {
	for name, mutate := range map[string]func(*P2PSignalData){"unknown-type": func(d *P2PSignalData) { d.Type = "source-map" }, "long-sdp": func(d *P2PSignalData) { d.SDP = strings.Repeat("x", 30001) }, "partial": func(d *P2PSignalData) { d.MediaProtocol = 0 }, "unsupported": func(d *P2PSignalData) { d.MediaProtocol = 2 }, "zero-revision": func(d *P2PSignalData) { d.DescriptionRevision = 0 }, "unsafe-js-number": func(d *P2PSignalData) { d.DescriptionRevision = 9007199254740992 }, "invalid-id": func(d *P2PSignalData) { d.DescriptionID = "invalid" }, "answer-no-relation": func(d *P2PSignalData) { d.Type = "answer" }, "offer-relation": func(d *P2PSignalData) { d.ReplyToDescriptionID = d.DescriptionID }, "unknown-capability": func(d *P2PSignalData) { d.Capabilities = []string{"unknown"} }, "duplicate-mid": func(d *P2PSignalData) { d.Sources[1].MID = "0" }, "duplicate-source": func(d *P2PSignalData) { d.Sources[1].Source = "microphone" }, "invalid-mid": func(d *P2PSignalData) { d.Sources[1].MID = "bad mid" }, "unknown-source": func(d *P2PSignalData) { d.Sources[1].Source = "unknown" }, "audio-no-capability": func(d *P2PSignalData) { d.Capabilities = nil }, "candidate-in-offer": func(d *P2PSignalData) { d.Candidate = map[string]any{"candidate": ""} }} {
		t.Run(name, func(t *testing.T) {
			d := validP2PDescription()
			mutate(&d)
			if d.Validate() == nil {
				t.Fatal("invalid payload accepted")
			}
		})
	}
	for _, d := range []P2PSignalData{validP2PDescription(), {CallID: "call", Type: "offer", SDP: "v=0"}, {CallID: "call", Type: "answer", SDP: "v=0"}, {CallID: "call", Type: "ice-candidate", Candidate: map[string]any{"candidate": "candidate:1", "sdpMid": "0", "sdpMLineIndex": float64(0), "usernameFragment": "abc"}}, {CallID: "call", Type: "ice-candidate", Candidate: map[string]any{"candidate": "", "sdpMid": nil, "sdpMLineIndex": nil}}} {
		if err := d.Validate(); err != nil {
			t.Fatalf("valid payload rejected: %v", err)
		}
	}
}
func TestP2PSignalICEBounds(t *testing.T) {
	for name, candidate := range map[string]any{"null": nil, "array": []string{"candidate"}, "unknown": map[string]any{"candidate": "", "actor": "other"}, "oversize": map[string]any{"candidate": strings.Repeat("x", 4097)}, "negative": map[string]any{"candidate": "", "sdpMLineIndex": -1}, "fraction": map[string]any{"candidate": "", "sdpMLineIndex": 0.5}, "wrong-mid": map[string]any{"candidate": "", "sdpMid": 1}} {
		t.Run(name, func(t *testing.T) {
			d := P2PSignalData{CallID: "call", Type: "ice-candidate", Candidate: candidate}
			if d.Validate() == nil {
				t.Fatal("invalid ICE accepted")
			}
		})
	}
}

func TestP2PSignalHandlerUsesValidatedDTOAndAuthenticatedActor(t *testing.T) {
	delivered := make(chan string, 1)
	hub := &Hub{onP2PSignal: func(actor string, data P2PSignalData) {
		if data.MediaProtocol != 1 || len(data.Sources) != 2 {
			delivered <- "bad-fields"
			return
		}
		delivered <- actor
	}}
	client := &Client{hub: hub, userID: "authenticated"}
	invalid := validP2PDescription()
	invalid.Sources[1].MID = "0"
	client.handleP2PSignal(Event{Data: invalid})
	client.handleP2PSignal(Event{Data: validP2PDescription()})
	select {
	case actor := <-delivered:
		if actor != "authenticated" {
			t.Fatal(actor)
		}
	case <-time.After(time.Second):
		t.Fatal("valid signal not delivered")
	}
	select {
	case <-delivered:
		t.Fatal("invalid signal delivered")
	case <-time.After(10 * time.Millisecond):
	}
}
