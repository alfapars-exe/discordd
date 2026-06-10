// Presence and typing indicator event handlers.
package ws

import (
	"encoding/json"
	"log"
)

// handlePresenceUpdate processes a client presence change.
// Updates per-connection status, computes aggregate across all connections,
// then delegates DB persist + broadcast to the callback.
func (c *Client) handlePresenceUpdate(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data PresenceData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	switch data.Status {
	case "online", "idle", "dnd", "offline":
		// valid
	default:
		log.Printf("[ws] invalid presence status from user %s: %s", c.userID, data.Status)
		return
	}

	c.hub.mu.Lock()
	c.status = data.Status
	aggregate := c.hub.computeAggregateStatusLocked(c.userID)
	c.hub.mu.Unlock()

	if c.hub.onPresenceManualUpdate != nil {
		go c.hub.onPresenceManualUpdate(c.userID, aggregate, data.IsAuto)
	}
}

// handleTyping validates channel access and broadcasts a typing indicator
// to the channel's server members only. Uses a callback to avoid Hub
// depending on channel/permission services directly (same pattern as DM typing).
func (c *Client) handleTyping(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var typing TypingData
	if err := json.Unmarshal(dataBytes, &typing); err != nil {
		return
	}

	if typing.ChannelID == "" {
		return
	}

	if c.hub.onChannelTyping != nil {
		username := c.hub.getUserUsername(c.userID)
		go c.hub.onChannelTyping(c.userID, username, typing.ChannelID)
	}
}

// handleDMTyping broadcasts a DM typing indicator to the other participant only.
// Uses a callback to avoid Hub depending on DM repo directly.
func (c *Client) handleDMTyping(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data struct {
		DMChannelID string `json:"dm_channel_id"`
	}
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.DMChannelID == "" {
		return
	}

	if c.hub.onDMTyping != nil {
		username := c.hub.getUserUsername(c.userID)
		go c.hub.onDMTyping(c.userID, username, data.DMChannelID)
	}
}
