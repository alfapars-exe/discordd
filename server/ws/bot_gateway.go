package ws

import (
	"context"
	"net/http"
	"strings"

	"github.com/argeinfina/hichat/models"
)

// BotTokenValidator resolves a bot bearer token to a bot user id.
type BotTokenValidator interface {
	ValidateBotToken(ctx context.Context, token string) (string, error)
}

// HandleBotConnection upgrades a bot WS connection. Auth is the bot token in
// the Authorization header; the bot is registered as a read-only client
// scoped to the servers it belongs to.
func (h *Handler) HandleBotConnection(w http.ResponseWriter, r *http.Request) {
	if h.botValidator == nil {
		http.Error(w, "bot gateway disabled", http.StatusNotFound)
		return
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !strings.HasPrefix(token, models.BotTokenPrefix) {
		http.Error(w, "bot token required", http.StatusUnauthorized)
		return
	}
	botUserID, err := h.botValidator.ValidateBotToken(r.Context(), token)
	if err != nil {
		http.Error(w, "invalid bot token", http.StatusUnauthorized)
		return
	}

	// Rejection parity with the HTTP middleware (middleware/auth.go) and the
	// human WS path (the bot paths use 401; the human WS path uses 403 — both
	// reject): a platform-banned bot — or a token row that somehow resolves to a
	// non-bot user — must not open the gateway. ValidateBotToken only proves
	// the token row is unrevoked; it does not see the user's ban state.
	if h.userInfoProvider != nil {
		botUser, e := h.userInfoProvider.GetByID(r.Context(), botUserID)
		if e != nil || !botUser.IsBot || botUser.IsPlatformBanned {
			http.Error(w, "bot unavailable", http.StatusUnauthorized)
			return
		}
	}

	// Scope the bot to the servers it belongs to so BroadcastToServer reaches
	// it (addClient indexes by client.serverIDs). Failures degrade gracefully:
	// an empty serverIDs set means the bot only receives non-server-scoped
	// events it is allowed to see, never a foreign server's traffic.
	var serverIDs []string
	if h.serverListProvider != nil {
		if servers, e := h.serverListProvider.GetUserServers(r.Context(), botUserID); e == nil {
			serverIDs = make([]string, len(servers))
			for i, s := range servers {
				serverIDs[i] = s.ID
			}
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &Client{
		hub:        h.hub,
		conn:       conn,
		userID:     botUserID,
		send:       make(chan []byte, sendBufferSize),
		prefStatus: "online",
		serverIDs:  serverIDs,
		isBot:      true,
	}
	h.hub.register <- client
	go client.WritePump()
	client.ReadPump()
}
