package ws

import (
	"encoding/json"
	"log"
)

// Broadcast paths: shape (event, audience) -> JSON -> client send channels.
// Every method takes h.mu.RLock — readers can run concurrently. Slow clients
// (full send buffer) get unregistered in a goroutine to avoid blocking the
// loop. Each broadcast bumps event.Seq atomically before marshaling.

// BroadcastToAll sends an event to all connected clients.
func (h *Hub) BroadcastToAll(event Event) {
	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal broadcast event: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, clients := range h.clients {
		for client := range clients {
			select {
			case client.send <- data:
			default:
				// Buffer full — slow client, queue for disconnect
				h.queueUnregister(client)
			}
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
		log.Printf("[ws] failed to marshal broadcast event: %v", err)
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
			select {
			case client.send <- data:
			default:
				h.queueUnregister(client)
			}
		}
	}
}

// BroadcastToAllExcept sends an event to everyone except the specified user.
func (h *Hub) BroadcastToAllExcept(excludeUserID string, event Event) {
	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal broadcast event: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for userID, clients := range h.clients {
		if userID == excludeUserID {
			continue
		}
		for client := range clients {
			select {
			case client.send <- data:
			default:
				h.queueUnregister(client)
			}
		}
	}
}

// BroadcastToUser sends an event to all connections of a specific user.
func (h *Hub) BroadcastToUser(userID string, event Event) {
	event.Seq = h.seq.Add(1)

	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal user event: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	if clients, ok := h.clients[userID]; ok {
		for client := range clients {
			select {
			case client.send <- data:
			default:
				h.queueUnregister(client)
			}
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
		log.Printf("[ws] failed to marshal server broadcast event: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.serverClients[serverID] {
		select {
		case client.send <- data:
		default:
			go func(c *Client) { h.unregister <- c }(client)
		}
	}
}

// BroadcastToServerExcept sends to all server members except the specified user.
func (h *Hub) BroadcastToServerExcept(serverID, excludeUserID string, event Event) {
	event.Seq = h.seq.Add(1)
	event.ServerID = serverID

	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal server broadcast event: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.serverClients[serverID] {
		if client.userID == excludeUserID {
			continue
		}
		select {
		case client.send <- data:
		default:
			go func(c *Client) { h.unregister <- c }(client)
		}
	}
}
