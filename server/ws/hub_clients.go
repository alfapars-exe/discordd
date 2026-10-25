package ws

import (
	"github.com/argeinfina/hichat/models"
	"github.com/gorilla/websocket"
	"time"
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
	defer func() {
		if client.registered != nil {
			close(client.registered)
		}
	}()
	h.mu.Lock()
	if h.shuttingDown {
		h.mu.Unlock()
		if client.done != nil {
			client.closeDone()
		}
		if client.conn != nil {
			_ = client.conn.Close()
		}
		return
	}

	isFirstConnection := len(h.clients[client.userID]) == 0
	if !isFirstConnection {
		for existing := range h.clients[client.userID] {
			client.prefStatus = existing.prefStatus
			break
		}
	}
	// Empty remains the legacy representation of the default account
	// preference. Use online for the live status without rewriting that value.
	connectionStatus := client.prefStatus
	if connectionStatus == "" {
		connectionStatus = "online"
	}
	client.status = connectionStatus
	client.connectionID = h.connectionSeq.Add(1)
	if isFirstConnection {
		if client.prefStatus == "offline" {
			h.invisibleUsers[client.userID] = true
		} else {
			delete(h.invisibleUsers, client.userID)
		}
	} else if client.prefStatus == "offline" {
		// A new tab inherits the account preference but must never clear a
		// hidden flag established by another tab's manual update.
		h.invisibleUsers[client.userID] = true
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

	var ticket *presenceCallbackTicket
	var activityConnectTicket *presenceCallbackTicket
	activityConnectCallback := h.onGameActivityConnect
	if isFirstConnection && h.onUserFirstConnect != nil {
		ticket = h.presenceCallbacks.reserve(client.userID, "user_first_connect")
	} else if !isFirstConnection && h.onPresenceManualUpdate != nil {
		ticket = h.presenceCallbacks.reserve(client.userID, "presence_manual_update")
	}
	// Reservation and submission order must match for the same user.
	// submit waits for the predecessor to be admitted; reserving activity
	// first but submitting presence first deadlocks registration before ready.
	if activityConnectCallback != nil {
		activityConnectTicket = h.presenceCallbacks.reserve(client.userID, "game_activity_connect")
	}
	userID := client.userID
	prefStatus := connectionStatus
	presenceCallback := h.onPresenceManualUpdate
	firstConnectCallback := h.onUserFirstConnect
	h.mu.Unlock()
	if isFirstConnection && firstConnectCallback != nil {
		h.presenceCallbacks.submit(ticket, func() { firstConnectCallback(userID, prefStatus) })
	} else if !isFirstConnection && presenceCallback != nil {
		h.presenceCallbacks.submit(ticket, func() { presenceCallback(userID, aggregateForExisting, true) })
	}
	if activityConnectCallback != nil {
		h.presenceCallbacks.submit(activityConnectTicket, func() { activityConnectCallback(userID, client.connectionID) })
	}
}

// RequestGameActivitySnapshot is called after ready is queued so activity
// snapshots cannot overtake the stream's initial synchronization marker.
func (h *Hub) RequestGameActivitySnapshot(userID string) {
	cb := h.onGameActivitySnapshot
	if cb != nil {
		go cb(userID)
	}
}

func (h *Hub) QueueGameActivityUpdate(client *Client, sequence uint64, game *GameActivityClientGame) {
	h.mu.Lock()
	if h.shuttingDown || h.clients[client.userID][client] != true || h.onGameActivityUpdate == nil {
		h.mu.Unlock()
		return
	}
	cb := h.onGameActivityUpdate
	ticket := h.presenceCallbacks.reserve(client.userID, "game_activity_update")
	userID, connectionID := client.userID, client.connectionID
	h.mu.Unlock()
	h.presenceCallbacks.submit(ticket, func() { cb(userID, connectionID, sequence, game) })
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
	var ticket *presenceCallbackTicket
	var disconnectCallback UserConnectionCallback
	var presenceCallback PresenceManualUpdateCallback
	var activityDisconnectCallback GameActivityConnectionCallback
	var activityDisconnectTicket *presenceCallbackTicket

	if clients, ok := h.clients[client.userID]; ok {
		if _, exists := clients[client]; exists {
			delete(clients, client)
			client.closeDone()
			activityDisconnectCallback = h.onGameActivityDisconnect

			// Remove this client from all server indexes it belonged to.
			for _, sid := range client.serverIDs {
				h.removeClientFromServerIndex(client, sid)
			}

			if len(clients) == 0 {
				delete(h.clients, client.userID)
				fullyDisconnected = true
				userID = client.userID
				delete(h.invisibleUsers, userID)
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
	if fullyDisconnected && h.onUserFullyDisconnected != nil {
		disconnectCallback = h.onUserFullyDisconnected
		ticket = h.presenceCallbacks.reserve(userID, "user_fully_disconnected")
	} else if partialDisconnect && h.onPresenceManualUpdate != nil {
		presenceCallback = h.onPresenceManualUpdate
		ticket = h.presenceCallbacks.reserve(userID, "presence_manual_update")
	}
	// Keep the same presence-before-activity order used by submit below.
	if activityDisconnectCallback != nil {
		activityDisconnectTicket = h.presenceCallbacks.reserve(client.userID, "game_activity_disconnect")
	}

	// h.mu is now held here too (deferred Unlock above, not the manual
	// Unlock() this used to have at this point) — evictUserInfo below is a
	// nested h.mu -> userMu acquisition rather than the fully independent
	// one this comment used to describe. Still no ordering hazard: nothing
	// in the package ever acquires userMu before h.mu (grep userMu — only
	// hub_state.go touches it, and none of those funcs take h.mu), so
	// there's no reverse-order path to deadlock against. Evict the cached
	// profile entry once the last connection is gone so userInfos doesn't
	// grow unboundedly over the process lifetime.
	if fullyDisconnected {
		h.evictUserInfo(userID)
	}

	h.mu.Unlock()
	if disconnectCallback != nil {
		h.presenceCallbacks.submit(ticket, func() { disconnectCallback(userID, "") })
	} else if presenceCallback != nil {
		h.presenceCallbacks.submit(ticket, func() { presenceCallback(userID, newAggregate, true) })
	}
	if activityDisconnectCallback != nil {
		h.presenceCallbacks.submit(activityDisconnectTicket, func() { activityDisconnectCallback(client.userID, client.connectionID) })
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
		if client.conn != nil {
			_ = client.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "session_revoked"), time.Now().Add(writeWait))
			_ = client.conn.Close()
		}
		h.unregister <- client
	}
}

// DisconnectSession leaves the account's other signed-in sessions connected.
// The durable tombstone is committed before the caller invokes this method.
func (h *Hub) DisconnectSession(userID, sessionID string) {
	h.mu.RLock()
	var clients []*Client
	for client := range h.clients[userID] {
		if client.sessionID == sessionID {
			clients = append(clients, client)
		}
	}
	h.mu.RUnlock()
	for _, client := range clients {
		if client.conn != nil {
			_ = client.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "session_revoked"), time.Now().Add(writeWait))
			_ = client.conn.Close()
		}
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

// CommitPresenceVisibility applies the visibility side effect of a persisted
// manual presence update only while the user is still connected with that
// account preference. A delayed DB callback for an older preference cannot
// reveal or hide a newer state.
func (h *Hub) CommitPresenceVisibility(userID, status string) bool {
	switch status {
	case "online", "idle", "dnd", "offline":
	default:
		return false
	}
	h.mu.Lock()
	clients := h.clients[userID]
	if len(clients) == 0 {
		h.mu.Unlock()
		return false
	}
	for client := range clients {
		preference := client.prefStatus
		if preference == "" {
			preference = "online"
		}
		if preference != status {
			h.mu.Unlock()
			return false
		}
	}
	if status == "offline" {
		h.invisibleUsers[userID] = true
	} else {
		delete(h.invisibleUsers, userID)
	}
	cb := h.onGameActivityPresenceChange
	h.mu.Unlock()
	if cb != nil {
		go cb(userID)
	}
	return true
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
