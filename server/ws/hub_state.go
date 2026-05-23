package ws

// State queries + cached user-info accessors + presence aggregation.

// statusPriority defines presence precedence. Higher = more "active".
// When a user has multiple connections, the highest priority wins.
var statusPriority = map[string]int{
	"online":  4,
	"idle":    3,
	"dnd":     2,
	"offline": 1,
}

// computeAggregateStatusLocked returns the highest-priority status across
// all connections for a user. MUST be called under h.mu Lock/RLock.
func (h *Hub) computeAggregateStatusLocked(userID string) string {
	clients := h.clients[userID]
	if len(clients) == 0 {
		return "offline"
	}

	bestPriority := 0
	bestStatus := "offline"
	for client := range clients {
		p := statusPriority[client.status]
		if p > bestPriority {
			bestPriority = p
			bestStatus = client.status
		}
	}
	return bestStatus
}

// GetOnlineUserIDs returns all connected user IDs (including invisible).
func (h *Hub) GetOnlineUserIDs() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	ids := make([]string, 0, len(h.clients))
	for userID := range h.clients {
		ids = append(ids, userID)
	}
	return ids
}

// GetVisibleOnlineUserIDs returns connected user IDs excluding invisible users.
// Used in the ready event to populate the online user list.
func (h *Hub) GetVisibleOnlineUserIDs() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	ids := make([]string, 0, len(h.clients))
	for userID := range h.clients {
		if h.invisibleUsers[userID] {
			continue
		}
		ids = append(ids, userID)
	}
	return ids
}

// GetOnlineUserIDsForServer returns deduplicated user IDs of clients in the given server.
// Used by services to scope permission checks to server members only.
func (h *Hub) GetOnlineUserIDsForServer(serverID string) []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	clients, ok := h.serverClients[serverID]
	if !ok {
		return nil
	}

	seen := make(map[string]bool, len(clients))
	for client := range clients {
		seen[client.userID] = true
	}
	ids := make([]string, 0, len(seen))
	for uid := range seen {
		ids = append(ids, uid)
	}
	return ids
}

// SetUserInfo caches user profile data at WS connect time.
func (h *Hub) SetUserInfo(userID, username, displayName, avatarURL string) {
	h.userMu.Lock()
	defer h.userMu.Unlock()
	h.userInfos[userID] = cachedUserInfo{
		Username:    username,
		DisplayName: displayName,
		AvatarURL:   avatarURL,
	}
}

func (h *Hub) getUserUsername(userID string) string {
	h.userMu.RLock()
	defer h.userMu.RUnlock()
	return h.userInfos[userID].Username
}

func (h *Hub) getUserInfo(userID string) cachedUserInfo {
	h.userMu.RLock()
	defer h.userMu.RUnlock()
	return h.userInfos[userID]
}
