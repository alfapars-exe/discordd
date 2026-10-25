// Presence and typing indicator event handlers.
package ws

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode"

	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/google/uuid"
)

func (c *Client) handleGameActivityUpdate(event Event) {
	raw, err := json.Marshal(event.Data)
	if err != nil {
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var payload GameActivityClientUpdate
	if err := decoder.Decode(&payload); err != nil {
		return
	}
	if payload.Game != nil && !validGameActivityInput(payload.Game) {
		return
	}
	if c.isBot {
		return
	}
	seq := c.activitySeq.Add(1)
	c.hub.QueueGameActivityUpdate(c, seq, payload.Game)
}

func validGameActivityInput(game *GameActivityClientGame) bool {
	if game == nil || len(game.ID) != 36 || len(game.Name) == 0 || len(game.Name) > 80 {
		return false
	}
	if _, err := uuid.Parse(game.ID); err != nil {
		return false
	}
	if strings.TrimSpace(game.ID) != game.ID || strings.TrimSpace(game.Name) != game.Name {
		return false
	}
	for _, value := range []string{game.ID, game.Name} {
		for _, r := range value {
			if r == '/' || r == '\\' || r == ':' || unicode.IsControl(r) {
				return false
			}
		}
	}
	return true
}

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
	if c.hub.shuttingDown {
		c.hub.mu.Unlock()
		return
	}
	if data.IsAuto {
		// Auto-idle is only valid for users whose account preference is
		// online (empty is the legacy representation of that default).
		// A stale event from an old tab must not override a later manual
		// DND or offline choice.
		if c.prefStatus != "" && c.prefStatus != "online" {
			c.hub.mu.Unlock()
			return
		}
		c.status = data.Status
	} else {
		// Manual presence is account-scoped. Update every connected tab in
		// one Hub critical section so aggregation cannot retain a stale
		// higher-priority status from another connection.
		for client := range c.hub.clients[c.userID] {
			client.prefStatus = data.Status
			client.status = data.Status
		}
		if data.Status == "offline" {
			// Hide immediately. Revealing a previously-hidden user waits for
			// the persistence callback to commit and revalidate this preference.
			c.hub.invisibleUsers[c.userID] = true
		}
	}
	aggregate := c.hub.computeAggregateStatusLocked(c.userID)
	callback := c.hub.onPresenceManualUpdate
	userID := c.userID
	var ticket *presenceCallbackTicket
	if callback != nil {
		ticket = c.hub.presenceCallbacks.reserve(userID, "presence_manual_update")
	}
	c.hub.mu.Unlock()
	if c.hub.onGameActivityPresenceChange != nil && data.Status == "offline" {
		cb := c.hub.onGameActivityPresenceChange
		go cb(userID)
	}
	if callback != nil {
		c.hub.presenceCallbacks.submit(ticket, func() { callback(userID, aggregate, data.IsAuto) })
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
