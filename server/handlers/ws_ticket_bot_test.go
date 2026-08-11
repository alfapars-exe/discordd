// WSTicket bot-rejection contract (pentest 2026-07-26 finding C-01; confirmed
// still open by the 2026-07-31 scan).
//
// POST /api/auth/ws-ticket is mounted behind AuthMiddleware.Require, which
// deliberately accepts `hb_`-prefixed bot tokens so bots can use the REST API.
// WSTicket then issued a ticket to whoever sat in the context — including a
// bot. That ticket opens GET /ws, the HUMAN gateway, where Client.isBot is
// never set, disabling both bot isolation layers (see
// ws/bot_human_gateway_test.go for the socket-side pin).
//
// This is the PRIMARY gate: refuse at mint time, so no bot ticket ever exists.
package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// TestWSTicket_BotForbidden pins the mint-time rejection. The handler is
// constructed with every dependency nil: the IsBot gate must fire before the
// wsTicketService nil-check that would otherwise return 404, which also proves
// the gate sits early enough that no ticket is minted on any path.
func TestWSTicket_BotForbidden(t *testing.T) {
	h := &AuthHandler{}

	req := httptest.NewRequest(http.MethodPost, "/api/auth/ws-ticket", nil)
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{
		ID:       "bot1",
		Username: "musicbot",
		IsBot:    true,
	}))

	rec := httptest.NewRecorder()
	h.WSTicket(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("bot requesting ws-ticket: got status %d, want %d", rec.Code, http.StatusForbidden)
	}
	if body := rec.Body.String(); body == "" {
		t.Error("expected a client-safe error message in the body, got empty")
	}
}

// TestWSTicket_HumanNotForbidden guards against the gate over-matching. With a
// nil wsTicketService a human falls through to the documented 404 ("feature not
// enabled"); the one status it must never get is 403.
func TestWSTicket_HumanNotForbidden(t *testing.T) {
	h := &AuthHandler{}

	req := httptest.NewRequest(http.MethodPost, "/api/auth/ws-ticket", nil)
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{
		ID:       "u1",
		Username: "alice",
		IsBot:    false,
	}))

	rec := httptest.NewRecorder()
	h.WSTicket(rec, req)

	if rec.Code == http.StatusForbidden {
		t.Error("human requesting ws-ticket got 403 — the IsBot gate must not catch humans")
	}
}
