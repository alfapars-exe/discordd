package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

type EmailVerificationHandler struct {
	svc     *services.EmailVerificationService
	limiter *ratelimit.LoginRateLimiter
}

func NewEmailVerificationHandler(svc *services.EmailVerificationService, limiter *ratelimit.LoginRateLimiter) *EmailVerificationHandler {
	return &EmailVerificationHandler{svc: svc, limiter: limiter}
}
func emailVerificationOwner(w http.ResponseWriter, r *http.Request) (*models.User, bool) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		pkg.Error(w, pkg.ErrUnauthorized)
		return nil, false
	}
	if user.IsBot {
		pkg.Error(w, pkg.ErrForbidden)
		return nil, false
	}
	return user, true
}
func (h *EmailVerificationHandler) Status(w http.ResponseWriter, r *http.Request) {
	user, ok := emailVerificationOwner(w, r)
	if !ok {
		return
	}
	if r.URL.Query().Get("expected_user_id") != user.ID {
		pkg.ErrorWithCode(w, 409, "account changed", "ACCOUNT_MISMATCH")
		return
	}
	status, err := h.svc.Status(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, 200, status)
}
func (h *EmailVerificationHandler) Request(w http.ResponseWriter, r *http.Request) {
	user, ok := emailVerificationOwner(w, r)
	if !ok {
		return
	}
	var req struct {
		ExpectedUserID string `json:"expected_user_id"`
		Generation     *int64 `json:"generation"`
	}
	if !decodeVerificationBody(w, r, &req) {
		return
	}
	if req.ExpectedUserID != user.ID {
		pkg.ErrorWithCode(w, 409, "account changed", "ACCOUNT_MISMATCH")
		return
	}
	if req.Generation == nil || *req.Generation < 0 {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	if err := h.svc.Request(r.Context(), user.ID, *req.Generation); err != nil {
		switch {
		case errors.Is(err, services.ErrVerificationUnavailable):
			pkg.ErrorWithCode(w, 503, "email delivery is not configured", "EMAIL_DELIVERY_UNAVAILABLE")
		case errors.Is(err, services.ErrVerificationCooldown):
			w.Header().Set("Retry-After", "60")
			pkg.ErrorWithCode(w, 429, "wait before requesting another link", "EMAIL_VERIFICATION_COOLDOWN")
		case errors.Is(err, services.ErrVerificationChanged):
			pkg.ErrorWithCode(w, 409, "email state changed; refresh status", "EMAIL_STATE_CHANGED")
		case errors.Is(err, services.ErrVerificationDelivery):
			pkg.ErrorWithCode(w, 503, "email delivery was not confirmed; refresh status before retrying", "EMAIL_DELIVERY_FAILED")
		default:
			pkg.Error(w, err)
		}
		return
	}
	pkg.JSON(w, 200, map[string]bool{"accepted": true})
}
func (h *EmailVerificationHandler) Verify(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.limiter != nil && !h.limiter.Allow(ratelimit.ExtractIP(r)) {
		w.Header().Set("Retry-After", "300")
		pkg.ErrorWithCode(w, 429, "too many verification attempts", "EMAIL_VERIFICATION_RATE_LIMITED")
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if !decodeVerificationBody(w, r, &req) {
		return
	}
	if err := h.svc.Verify(r.Context(), req.Token); err != nil {
		if errors.Is(err, services.ErrVerificationInvalid) {
			pkg.ErrorWithCode(w, 400, "invalid or expired verification link", "EMAIL_VERIFICATION_INVALID")
		} else {
			pkg.Error(w, err)
		}
		return
	}
	pkg.JSON(w, 200, map[string]bool{"verified": true})
}
func decodeVerificationBody(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		pkg.Error(w, pkg.ErrBadRequest)
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkg.Error(w, pkg.ErrBadRequest)
		return false
	}
	return true
}
