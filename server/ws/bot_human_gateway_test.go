package ws

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// Regression net for the bot -> human WebSocket escalation (pentest 2026-07-26,
// finding C-01; confirmed still open by the 2026-07-31 scan).
//
// The chain was: AuthMiddleware.Require accepts `hb_` bot tokens, so a bot could
// call POST /api/auth/ws-ticket, receive a ticket, and open GET /ws — the HUMAN
// gateway. HandleConnection never set Client.isBot (only bot_gateway.go does),
// so BOTH isolation layers silently disengaged:
//
//	outbound: hub_broadcast.go   `if client.isBot && !BotReadableOps[op]`
//	inbound:  client_dispatch.go `if c.isBot && event.Op != OpHeartbeat`
//
// A bot therefore received DMs, voice_state, device_key_change, presence and
// audit events, and could send action ops.
//
// The fix rejects rather than propagates isBot: bots have their own read-only
// route (GET /api/bot/gateway -> HandleBotConnection), so a bot arriving at
// HandleConnection is always wrong and the connection must never exist. The
// primary gate lives at mint time in handlers.WSTicket; this is defense in
// depth for anything that reaches the socket another way (legacy ?token= path,
// a future auth route, a regressed WSTicket).
//
// Scope note: like handler_auth_test.go, only the pre-upgrade reject path is
// exercised — httptest.NewRecorder cannot hijack the connection.

func botUser() *models.User {
	return &models.User{
		ID:               "bot1",
		Username:         "musicbot",
		IsBot:            true,
		TokenVersion:     0,
		IsPlatformBanned: false,
		PrefStatus:       models.UserStatusOnline,
	}
}

// TestHandleConnection_BotRejectedOnHumanGateway is the C-01 regression pin.
// A bot presenting a valid ticket must be refused before the upgrade.
func TestHandleConnection_BotRejectedOnHumanGateway(t *testing.T) {
	h := &Handler{
		hub:              NewHub(),
		ticketConsumer:   stubTicketConsumer{userID: "bot1"},
		userInfoProvider: stubUserInfoProvider{user: botUser()},
	}

	rec := httptest.NewRecorder()
	h.HandleConnection(rec, httptest.NewRequest(http.MethodGet, "/ws?ticket=x", nil))

	if rec.Code != http.StatusForbidden {
		t.Errorf("bot on human gateway: got status %d, want %d (bot must be rejected pre-upgrade)",
			rec.Code, http.StatusForbidden)
	}
}

// TestHandleConnection_HumanStillReachesUpgrade guards the other direction: the
// new IsBot gate must not reject ordinary users. A human with the same wiring
// gets past every pre-upgrade reject branch and fails only at the upgrade
// itself, which httptest cannot hijack — so any 4xx here means the gate
// over-matched and broke normal login.
func TestHandleConnection_HumanStillReachesUpgrade(t *testing.T) {
	h := &Handler{
		hub:              NewHub(),
		ticketConsumer:   stubTicketConsumer{userID: "u1"},
		userInfoProvider: stubUserInfoProvider{user: okUser()},
	}

	rec := httptest.NewRecorder()
	h.HandleConnection(rec, httptest.NewRequest(http.MethodGet, "/ws?ticket=x", nil))

	if rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
		t.Errorf("human on human gateway: got status %d, want no auth rejection — the IsBot gate must not catch humans",
			rec.Code)
	}
}
