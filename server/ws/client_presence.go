// Presence and typing indicator event handlers.
package ws

import (
	"encoding/json"

	"github.com/argeinfina/hichat/pkg/logx"
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
		// data.Status is client-controlled — passed as a structured attr, not
		// interpolated into the message (G706).
		dispatchLogger.Warn("invalid presence status from client", "user_id", c.userID, "status", data.Status)
		return
	}

	c.hub.mu.Lock()
	defer c.hub.mu.Unlock()
	c.status = data.Status
	aggregate := c.hub.computeAggregateStatusLocked(c.userID)

	// onPresenceManualUpdate is dispatched via logx.Go (separate goroutine),
	// not called synchronously, so holding c.hub.mu through the dispatch
	// (deferred Unlock above, rather than the manual Unlock() this used to
	// have right after computeAggregateStatusLocked) doesn't risk
	// deadlocking the callback against this lock.
	if c.hub.onPresenceManualUpdate != nil {
		logx.Go("ws.presence_manual_update", func() { c.hub.onPresenceManualUpdate(c.userID, aggregate, data.IsAuto) })
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
		logx.Go("ws.channel_typing", func() { c.hub.onChannelTyping(c.userID, username, typing.ChannelID) })
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
		logx.Go("ws.dm_typing", func() { c.hub.onDMTyping(c.userID, username, data.DMChannelID) })
	}
}
