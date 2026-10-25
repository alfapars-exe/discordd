package ws

import (
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"math"
	"regexp"
	"strings"
)

var p2pMID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// Validate bounds the actual relayed DTO. SDP/MID semantics belong to the
// receiving peer's exact RTCPeerConnection, not this signaling relay.
func (d P2PSignalData) Validate() error {
	bad := func() error { return fmt.Errorf("invalid P2P signal") }
	if d.CallID == "" || len(d.CallID) > 128 {
		return bad()
	}
	if d.Type != "offer" && d.Type != "answer" && d.Type != "ice-candidate" {
		return bad()
	}
	if d.Type == "ice-candidate" {
		if d.SDP != "" || d.MediaProtocol != 0 || d.DescriptionID != "" || d.DescriptionRevision != 0 || d.ReplyToDescriptionID != "" || len(d.Capabilities) > 0 || len(d.Sources) > 0 {
			return bad()
		}
		encoded, err := json.Marshal(d.Candidate)
		if err != nil || len(encoded) > 8192 || d.Candidate == nil {
			return bad()
		}
		var candidate map[string]json.RawMessage
		if json.Unmarshal(encoded, &candidate) != nil || candidate == nil {
			return bad()
		}
		for key, value := range candidate {
			switch key {
			case "candidate":
				var text string
				if json.Unmarshal(value, &text) != nil || len(text) > 4096 {
					return bad()
				}
			case "sdpMid", "usernameFragment":
				if string(value) != "null" {
					var text string
					if json.Unmarshal(value, &text) != nil || len(text) > 256 {
						return bad()
					}
				}
			case "sdpMLineIndex":
				if string(value) != "null" {
					var number float64
					if json.Unmarshal(value, &number) != nil || number < 0 || number > 65535 || math.Trunc(number) != number {
						return bad()
					}
				}
			default:
				return bad()
			}
		}
		if _, ok := candidate["candidate"]; !ok {
			return bad()
		}
		return nil
	}
	if d.SDP == "" || len(d.SDP) > 30000 || d.Candidate != nil {
		return bad()
	}
	if d.MediaProtocol == 0 {
		if d.DescriptionID != "" || d.DescriptionRevision != 0 || d.ReplyToDescriptionID != "" || len(d.Capabilities) > 0 || len(d.Sources) > 0 {
			return bad()
		}
		return nil
	}
	if d.MediaProtocol != 1 || d.DescriptionRevision == 0 || d.DescriptionRevision > 9007199254740991 {
		return bad()
	}
	validID := func(value string) bool {
		parsed, err := uuid.Parse(value)
		return err == nil && parsed != uuid.Nil && strings.EqualFold(parsed.String(), value)
	}
	if !validID(d.DescriptionID) || len(d.Capabilities) > 1 || len(d.Sources) > 4 {
		return bad()
	}
	if d.Type == "offer" {
		if d.ReplyToDescriptionID != "" {
			return bad()
		}
	} else if !validID(d.ReplyToDescriptionID) {
		return bad()
	}
	for _, capability := range d.Capabilities {
		if capability != "screen-audio-v1" {
			return bad()
		}
	}
	seen := map[string]bool{}
	kinds := map[string]bool{}
	for _, source := range d.Sources {
		if !p2pMID.MatchString(source.MID) || seen[source.MID] || kinds[source.Source] {
			return bad()
		}
		seen[source.MID] = true
		kinds[source.Source] = true
		switch source.Source {
		case "microphone", "camera", "screen-video":
		case "screen-audio":
			if len(d.Capabilities) != 1 {
				return bad()
			}
		default:
			return bad()
		}
	}
	return nil
}
