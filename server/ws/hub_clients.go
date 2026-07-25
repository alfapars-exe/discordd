package ws

import (
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/logx"
)

// Client connection lifecycle + server-membership index maintenance.
// All mutations live under h.mu (write Lock); reads under RLock.

// addClientToServerIndex adds a client to the serverClients index for serverID.
// MUST be called under h.mu Lock.
func (h *Hub) addClientToServerIndex(client *Client, serverID string) {
	if _, ok := h.serverClients[serverID]; !ok {
		h.serverClients[serverID] = make(map[*Client]bool)
	}
	h.serverClients[serverID][client] = true
}

// removeClientFromServerIndex removes a client from the serverClients index.
// MUST be called under h.mu Lock.
func (h *Hub) removeClientFromServerIndex(client *Client, serverID string) {
	if clients, ok := h.serverClients[serverID]; ok {
		delete(clients, client)
		if len(clients) == 0 {
			delete(h.serverClients, serverID)
		}
	}
}

// addClient registers a new client. Fires OnUserFirstConnect for the user's
// first connection. For subsequent connections, recomputes aggregate status.
func (h *Hub) addClient(client *Client) {
	h.mu.Lock()

	isFirstConnection := len(h.clients[client.userID]) == 0

	// Set per-connection status from prefStatus or default to "online"
	switch {
	case client.prefStatus != "" && client.prefStatus != "offline":
		client.status = client.prefStatus
	case client.prefStatus == "offline":
		client.status = "offline"
	default:
		client.status = "online"
	}

	if _, ok := h.clients[client.userID]; !ok {
		h.clients[client.userID] = make(map[*Client]bool)
	}
	h.clients[client.userID][client] = true

	// Index this client by its serverIDs (set by handler.go before register).
	for _, sid := range client.serverIDs {
		h.addClientToServerIndex(client, sid)
	}

	// New connection may change aggregate (e.g. existing idle + new online = online)
	var aggregateForExisting string
	if !isFirstConnection {
		aggregateForExisting = h.computeAggregateStatusLocked(client.userID)
	}

	hubLogger.Info("client connected",
		"user_id", client.userID, "status", client.status,
		"total_connections", len(h.clients[client.userID]))

	h.mu.Unlock()

	// Callbacks run outside lock in separate goroutines to prevent deadlock
	if isFirstConnection && h.onUserFirstConnect != nil {
		userID := client.userID
		prefStatus := client.prefStatus
		logx.Go("ws.user_first_connect", func() { h.onUserFirstConnect(userID, prefStatus) })
	} else if !isFirstConnection && h.onPresenceManualUpdate != nil {
		logx.Go("ws.presence_manual_update", func() { h.onPresenceManualUpdate(client.userID, aggregateForExisting, true) })
	}
}

// removeClient unregisters a client and signals its done channel (which stops
// WritePump and any in-flight sendEvent). Fires OnUserFullyDisconnected when
// the last connection closes.
// Otherwise recomputes and broadcasts aggregate status.
func (h *Hub) removeClient(client *Client) {
	h.mu.Lock()

	var fullyDisconnected bool
	var partialDisconnect bool
	var userID string
	var newAggregate string

	if clients, ok := h.clients[client.userID]; ok {
		if _, exists := clients[client]; exists {
			delete(clients, client)
			client.closeDone()

			// Remove this client from all server indexes it belonged to.
			for _, sid := range client.serverIDs {
				h.removeClientFromServerIndex(client, sid)
			}

			if len(clients) == 0 {
				delete(h.clients, client.userID)
				fullyDisconnected = true
				userID = client.userID
				hubLogger.Info("user fully disconnected", "user_id", client.userID)
				h.logEvent(models.LogLevelInfo, models.LogCategoryWS, &client.userID,
					"user fully disconnected (all tabs closed)", nil)
			} else {
				partialDisconnect = true
				userID = client.userID
				newAggregate = h.computeAggregateStatusLocked(client.userID)
				hubLogger.Info("client disconnected",
					"user_id", client.userID, "remaining_connections", len(clients),
					"aggregate_status", newAggregate)
			}
		}
	}

	h.mu.Unlock()

	// userMu is independent of h.mu (no lock ordering hazard) — evict the
	// cached profile entry once the last connection is gone so userInfos
	// doesn't grow unboundedly over the process lifetime.
	if fullyDisconnected {
		h.evictUserInfo(userID)
	}

	if fullyDisconnected && h.onUserFullyDisconnected != nil {
		logx.Go("ws.user_fully_disconnected", func() { h.onUserFullyDisconnected(userID, "") })
	} else if partialDisconnect && h.onPresenceManualUpdate != nil {
		logx.Go("ws.presence_manual_update", func() { h.onPresenceManualUpdate(userID, newAggregate, true) })
	}
}

// DisconnectUser forcefully closes all WS connections for a user (e.g. after ban).
func (h *Hub) DisconnectUser(userID string) {
	h.mu.RLock()
	clients := make([]*Client, 0)
	if userClients, ok := h.clients[userID]; ok {
		for client := range userClients {
			clients = append(clients, client)
		}
	}
	h.mu.RUnlock()

	for _, client := range clients {
		h.unregister <- client
	}
}

// SetInvisible marks a user as invisible (connected but hidden from online lists).
func (h *Hub) SetInvisible(userID string, invisible bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if invisible {
		h.invisibleUsers[userID] = true
	} else {
		delete(h.invisibleUsers, userID)
	}
}

// AddClientServerID adds a server ID to all connections of a user (on server join).
func (h *Hub) AddClientServerID(userID, serverID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if clients, ok := h.clients[userID]; ok {
		for client := range clients {
			if !clientHasServer(client, serverID) {
				client.serverIDs = append(client.serverIDs, serverID)
				h.addClientToServerIndex(client, serverID)
			}
		}
	}
}

// RemoveClientServerID removes a server ID from all connections of a user (on leave/kick).
func (h *Hub) RemoveClientServerID(userID, serverID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if clients, ok := h.clients[userID]; ok {
		for client := range clients {
			for i, id := range client.serverIDs {
				if id == serverID {
					client.serverIDs = append(client.serverIDs[:i], client.serverIDs[i+1:]...)
					h.removeClientFromServerIndex(client, serverID)
					break
				}
			}
		}
	}
}

// SetClientServerIDs sets all server IDs for a client (at WS connect, from DB).
// Removes the client from any previously-indexed servers and re-indexes for the new set.
func (h *Hub) SetClientServerIDs(client *Client, serverIDs []string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	for _, sid := range client.serverIDs {
		h.removeClientFromServerIndex(client, sid)
	}
	client.serverIDs = serverIDs
	for _, sid := range serverIDs {
		h.addClientToServerIndex(client, sid)
	}
}

// clientHasServer checks if a client is a member of the given server.
// O(n) where n = number of servers per user (typically 3-10).
func clientHasServer(client *Client, serverID string) bool {
	for _, id := range client.serverIDs {
		if id == serverID {
			return true
		}
	}
	return false
}
