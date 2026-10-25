package ws

import (
	"encoding/json"
	"testing"
)

func presenceClient(h *Hub, userID, prefStatus string) *Client {
	return &Client{
		hub:        h,
		userID:     userID,
		prefStatus: prefStatus,
		send:       make(chan []byte, 1),
		done:       make(chan struct{}),
	}
}

func sendPresenceUpdate(c *Client, status string, isAuto bool) {
	c.handlePresenceUpdate(Event{Data: map[string]any{
		"status":  status,
		"is_auto": isAuto,
	}})
}

func aggregatePresence(h *Hub, userID string) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.computeAggregateStatusLocked(userID)
}

func TestManualPresenceAppliesAccountPreferenceToAllConnections(t *testing.T) {
	for _, status := range []string{"dnd", "offline"} {
		t.Run(status, func(t *testing.T) {
			h := NewHub()
			first := presenceClient(h, "user", "online")
			second := presenceClient(h, "user", "idle")
			h.addClient(first)
			h.addClient(second)

			sendPresenceUpdate(first, status, false)
			for _, client := range []*Client{first, second} {
				if client.status != status || client.prefStatus != status {
					t.Fatalf("manual %s did not update all tabs: status=%q pref=%q", status, client.status, client.prefStatus)
				}
			}
			if got := aggregatePresence(h, "user"); got != status {
				t.Fatalf("aggregate status = %q, want %q", got, status)
			}

			// A late auto-idle packet from the other tab cannot override the
			// account-level manual preference.
			sendPresenceUpdate(second, "idle", true)
			if second.status != status || second.prefStatus != status {
				t.Fatalf("stale auto update changed manual %s: status=%q pref=%q", status, second.status, second.prefStatus)
			}
			if got := aggregatePresence(h, "user"); got != status {
				t.Fatalf("stale auto update changed aggregate to %q", got)
			}
		})
	}
}

func TestAutoIdleAppliesForOnlinePreferenceAndLegacyDefault(t *testing.T) {
	for _, prefStatus := range []string{"online", ""} {
		t.Run(map[string]string{"online": "explicit_online", "": "legacy_default"}[prefStatus], func(t *testing.T) {
			h := NewHub()
			c := presenceClient(h, "user", prefStatus)
			h.addClient(c)

			sendPresenceUpdate(c, "idle", true)
			if c.status != "idle" {
				t.Fatalf("auto-idle status = %q, want idle", c.status)
			}
			if c.prefStatus != prefStatus {
				t.Fatalf("auto-idle changed account preference to %q, want %q", c.prefStatus, prefStatus)
			}
		})
	}
}

func TestPresenceDataAlwaysSerializesIsAuto(t *testing.T) {
	encoded, err := json.Marshal(PresenceData{UserID: "user", Status: "online", IsAuto: false})
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	if value, exists := payload["is_auto"]; !exists || value != false {
		t.Fatalf("is_auto false was omitted or changed: %s", encoded)
	}
}
