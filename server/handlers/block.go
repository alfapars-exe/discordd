package handlers

import (
	"fmt"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

// BlockHandler handles user block/unblock endpoints.
type BlockHandler struct {
	service services.BlockService
	// limiter throttles BlockUser only (Faz B, 2026-10-21): a block pushes
	// user_block to both parties (and friend_remove when a relationship
	// existed), so it is the one endpoint here that fans out to someone else.
	// Shared with FriendshipHandler.SendRequest (see RateLimiters.SocialAction).
	// nil disables the check (tests).
	limiter *ratelimit.MessageRateLimiter
}

func NewBlockHandler(service services.BlockService, limiter *ratelimit.MessageRateLimiter) *BlockHandler {
	return &BlockHandler{service: service, limiter: limiter}
}

func blockAccountMatches(w http.ResponseWriter, r *http.Request, userID string) bool {
	if expected := r.URL.Query().Get("expected_user_id"); expected != "" && expected != userID {
		pkg.ErrorWithCode(w, http.StatusConflict, "block account changed", "BLOCK_ACCOUNT_MISMATCH")
		return false
	}
	return true
}

// BlockUser -- POST /api/users/{userId}/block
func (h *BlockHandler) BlockUser(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if !blockAccountMatches(w, r, user.ID) {
		return
	}
	if h.limiter != nil && !h.limiter.Allow(user.ID) {
		retryAfter := h.limiter.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many block requests, please wait %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	targetID := r.PathValue("userId")
	if targetID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "userId is required")
		return
	}

	if err := h.service.BlockUser(r.Context(), user.ID, targetID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UnblockUser -- DELETE /api/users/{userId}/block
func (h *BlockHandler) UnblockUser(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if !blockAccountMatches(w, r, user.ID) {
		return
	}
	targetID := r.PathValue("userId")
	if targetID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "userId is required")
		return
	}

	if err := h.service.UnblockUser(r.Context(), user.ID, targetID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ListBlocked -- GET /api/users/blocked
func (h *BlockHandler) ListBlocked(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if !blockAccountMatches(w, r, user.ID) {
		return
	}
	blocked, err := h.service.ListBlocked(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, blocked)
}
