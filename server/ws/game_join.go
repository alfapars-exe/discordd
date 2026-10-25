package ws

import (
	"context"
	"github.com/argeinfina/hichat/pkg"
)

// Snapshot the physical session under the hub lock, perform its fresh DB check
// after releasing that lock. The final WithGameActivityConnection fences removal.
func (h *Hub) ValidateGameActivityConnection(ctx context.Context, user string, id uint64) error {
	h.mu.RLock()
	var found *Client
	if !h.shuttingDown {
		for c := range h.clients[user] {
			if c.connectionID == id {
				found = c
				break
			}
		}
	}
	h.mu.RUnlock()
	if found == nil || found.isBot || found.sessionID == "" || found.validateSession == nil {
		return pkg.ErrForbidden
	}
	return found.validateSession(ctx, user, found.sessionID)
}

// Commit performs no database or socket operations. Holding the read lock
// makes physical disconnect and one-use ticket admission mutually ordered.
func (h *Hub) WithGameActivityConnection(user string, id uint64, commit func() error) error {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if !h.shuttingDown {
		for c := range h.clients[user] {
			if c.connectionID == id {
				return commit()
			}
		}
	}
	return pkg.ErrForbidden
}

func (h *Hub) OnGameJoinOffer(cb func(string, uint64, any) any) { h.onGameJoinOffer = cb }
func (h *Hub) HasGameActivityConnection(user string, id uint64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.shuttingDown {
		return false
	}
	for c := range h.clients[user] {
		if c.connectionID == id {
			return true
		}
	}
	return false
}
func (c *Client) handleGameJoinOffer(event Event) {
	if c.isBot {
		return
	}
	h := c.hub
	h.mu.Lock()
	if h.shuttingDown || !h.clients[c.userID][c] || h.onGameJoinOffer == nil {
		h.mu.Unlock()
		return
	}
	cb := h.onGameJoinOffer
	ticket := h.presenceCallbacks.reserve(c.userID, "game_join_offer")
	h.mu.Unlock()
	h.presenceCallbacks.submit(ticket, func() {
		if !h.HasGameActivityConnection(c.userID, c.connectionID) {
			return
		}
		response := cb(c.userID, c.connectionID, event.Data)
		if response != nil {
			c.sendEvent(Event{Op: "game_join_offer_state", Data: response})
		}
	})
}
