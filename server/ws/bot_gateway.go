package ws

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/gorilla/websocket"
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
		done:       make(chan struct{}),
		prefStatus: "online",
		serverIDs:  serverIDs,
		isBot:      true,
		registered: make(chan struct{}),
	}
	// Keep the connection bound to the exact credential used for admission.
	// WritePump invokes this on every keepalive tick, limiting cross-process
	// token revocation/removal exposure even when this process did not commit
	// the change. The token is never logged or sent to the hub.
	client.validateSession = func(ctx context.Context, expectedBotID, _ string) error {
		currentBotID, validateErr := h.botValidator.ValidateBotToken(ctx, token)
		if validateErr != nil || currentBotID != expectedBotID {
			return pkg.ErrUnauthorized
		}
		return nil
	}
	h.hub.register <- client
	select {
	case <-client.registered:
	case <-r.Context().Done():
		_ = conn.Close()
		h.hub.unregister <- client
		return
	}

	// Close the token-validation/registration race. Application removal and
	// token revocation disconnect already-visible clients; this second check
	// catches a removal that committed after the first validation but before
	// this client became visible to DisconnectUser.
	if validateErr := client.validateSession(r.Context(), botUserID, ""); validateErr != nil {
		if errors.Is(validateErr, pkg.ErrUnauthorized) {
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "credential_revoked"), time.Now().Add(writeWait))
		}
		_ = conn.Close()
		h.hub.unregister <- client
		return
	}
	logx.Go("ws.bot_write_pump", client.WritePump)
	client.ReadPump()
}
