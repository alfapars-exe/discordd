// Bot management endpoints (Task 6): owner-facing create / list / revoke for
// automation accounts. The caller is always the authenticated human (resolved
// from UserContextKey by the auth middleware); bot accounts are blocked from
// creating further bots so a leaked bot token can't fan out new credentials.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// BotService is the subset of *services.BotService this handler needs. Keeping
// it as a local interface lets the handler be unit-tested with a fake.
type BotService interface {
	CreateBot(ctx context.Context, ownerID string, req models.CreateBotRequest) (*models.User, string, error)
	ListBots(ctx context.Context, ownerID string) ([]models.User, error)
	RevokeAllTokens(ctx context.Context, ownerID, botID string) error
}

// BotHandler serves owner-facing bot management routes.
type BotHandler struct{ svc BotService }

// NewBotHandler constructs a BotHandler around the given service.
func NewBotHandler(svc BotService) *BotHandler { return &BotHandler{svc: svc} }

// Create handles POST /api/bots — registers a bot owned by the caller and
// returns the bot together with its plaintext token. The token is shown ONCE;
// only its hash is stored server-side, so the client must persist it now.
func (h *BotHandler) Create(w http.ResponseWriter, r *http.Request) {
	owner, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	// A bot must never mint another bot: that would let a single leaked bot
	// token bootstrap an unbounded set of credentials outside the owner's view.
	if owner.IsBot {
		pkg.ErrorWithMessage(w, http.StatusForbidden, "bots cannot create bots")
		return
	}

	var req models.CreateBotRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	bot, token, err := h.svc.CreateBot(r.Context(), owner.ID, req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, map[string]any{"bot": bot, "token": token})
}

// List handles GET /api/bots — returns every bot owned by the caller.
func (h *BotHandler) List(w http.ResponseWriter, r *http.Request) {
	owner, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	bots, err := h.svc.ListBots(r.Context(), owner.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]any{"bots": bots})
}

// Revoke handles POST /api/bots/{botID}/revoke — revokes every token of one
// bot owned by the caller, effectively disabling it. The service scopes the
// revoke to (ownerID, botID) so a caller can never revoke another owner's bot.
func (h *BotHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	owner, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	botID := r.PathValue("botID")
	if err := h.svc.RevokeAllTokens(r.Context(), owner.ID, botID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
