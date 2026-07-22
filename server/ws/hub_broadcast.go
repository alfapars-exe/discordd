package ws

import (
	"encoding/json"

	"github.com/argeinfina/hichat/pkg"
)

// Broadcast paths: shape (event, audience) -> JSON -> client send channels.
// Every method takes h.mu.RLock — readers can run concurrently. Slow clients
// (full send buffer) get unregistered in a goroutine to avoid blocking the
// loop. Each broadcast bumps event.Seq atomically before marshaling.

// errMarshalBroadcastEvent is the shared log message for the three broadcast
// methods below — one constant instead of the literal repeated at each call
// site, so a wording change can't drift between them.
const errMarshalBroadcastEvent = "failed to marshal broadcast event"

// deliver enqueues pre-marshaled bytes to one client, applying the bot
// read-only filter. This is the SINGLE place per-client delivery happens —
// every broadcast method funnels through it so the bot allow-list cannot be
// bypassed by a new broadcast path forgetting to filter.
func (h *Hub) deliver(client *Client, op string, data []byte) {
	if client.isBot && !BotReadableOps[op] {
		return
	}
	select {
	case client.send <- data:
	default:
		h.queueUnregister(client)
	}
}

// BroadcastToAll sends an event to all connected clients.
func (h *Hub) BroadcastToAll(event Event) {
	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		hubLogger.Error(errMarshalBroadcastEvent, "op", event.Op, "err", pkg.ErrText(err))
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, clients := range h.clients {
		for client := range clients {
			h.deliver(client, event.Op, data)
		}
	}
}

// BroadcastToUsers sends an event to a specific set of users.
func (h *Hub) BroadcastToUsers(userIDs []string, event Event) {
	if len(userIDs) == 0 {
		return
	}

	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		hubLogger.Error(errMarshalBroadcastEvent, "op", event.Op, "err", pkg.ErrText(err))
		return
	}

	allowed := make(map[string]bool, len(userIDs))
	for _, id := range userIDs {
		allowed[id] = true
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for userID, clients := range h.clients {
		if !allowed[userID] {
			continue
		}
		for client := range clients {
			h.deliver(client, event.Op, data)
		}
	}
}

// BroadcastToAllExcept sends an event to everyone except the specified user.
func (h *Hub) BroadcastToAllExcept(excludeUserID string, event Event) {
	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		hubLogger.Error(errMarshalBroadcastEvent, "op", event.Op, "err", pkg.ErrText(err))
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for userID, clients := range h.clients {
		if userID == excludeUserID {
			continue
		}
		for client := range clients {
			h.deliver(client, event.Op, data)
		}
	}
}

// BroadcastToUser sends an event to all connections of a specific user.
func (h *Hub) BroadcastToUser(userID string, event Event) {
	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		hubLogger.Error("failed to marshal user event", "op", event.Op, "err", pkg.ErrText(err))
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	if clients, ok := h.clients[userID]; ok {
		for client := range clients {
			h.deliver(client, event.Op, data)
		}
	}
}

// ─── Multi-Server Broadcast ───

// BroadcastToServer sends an event to all connected members of a specific server.
// Automatically injects server_id into the event so clients can route to the correct cache.
// Uses serverClients index for O(server_size) lookup instead of scanning all clients.
func (h *Hub) BroadcastToServer(serverID string, event Event) {
	event.Seq = h.seq.Add(1)
	event.ServerID = serverID

	data, err := json.Marshal(event)
	if err != nil {
		hubLogger.Error("failed to marshal server broadcast event", "op", event.Op, "server_id", serverID, "err", pkg.ErrText(err))
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	// Match the rest of the broadcast methods — bounded queue instead of an
	// ad-hoc `go func() { h.unregister <- c }`. Under a thundering-herd
	// disconnect (e.g. server-wide announcement after a network blip), the
	// goroutine form spawned one goroutine per slow client per broadcast and
	// left them blocked on `h.unregister` until drained, stacking up
	// unboundedly. deliver/queueUnregister are non-blocking and deduplicate
	// internally (and deliver applies the bot read-only filter).
	for client := range h.serverClients[serverID] {
		h.deliver(client, event.Op, data)
	}
}

// BroadcastToServerExcept sends to all server members except the specified user.
func (h *Hub) BroadcastToServerExcept(serverID, excludeUserID string, event Event) {
	event.Seq = h.seq.Add(1)
	event.ServerID = serverID

	data, err := json.Marshal(event)
	if err != nil {
		hubLogger.Error("failed to marshal server broadcast event", "op", event.Op, "server_id", serverID, "err", pkg.ErrText(err))
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.serverClients[serverID] {
		if client.userID == excludeUserID {
			continue
		}
		// See BroadcastToServer above — same goroutine-leak fix; deliver also
		// applies the bot read-only filter.
		h.deliver(client, event.Op, data)
	}
}
