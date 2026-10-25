package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

func (h *AuthHandler) SetMFAService(service *services.MFAService) { h.mfa = service }

func writeMFAError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, services.ErrMFARequired):
		pkg.ErrorWithCode(w, 401, "verification code required", "MFA_REQUIRED")
	case errors.Is(err, services.ErrMFAInvalid):
		pkg.ErrorWithCode(w, 401, "invalid or already used verification code", "MFA_INVALID")
	case errors.Is(err, services.ErrMFARateLimited):
		w.Header().Set("Retry-After", "300")
		pkg.ErrorWithCode(w, 429, "too many security attempts; try again later", "MFA_RATE_LIMITED")
	default:
		return false
	}
	return true
}

func (h *AuthHandler) MFAStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if h.mfa == nil {
		pkg.ErrorWithCode(w, 503, "MFA unavailable", "MFA_UNAVAILABLE")
		return
	}
	if r.URL.Query().Get("expected_user_id") != user.ID {
		pkg.ErrorWithCode(w, 409, "account changed; sign in again", "ACCOUNT_MISMATCH")
		return
	}
	status, err := h.mfa.Status(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, 200, status)
}

// MFAAction dispatches authenticated, account-bound management operations.
// Plaintext setup secrets and newly generated codes are returned once, never
// stored in an auth token, log, localStorage or general user JSON payload.
func (h *AuthHandler) MFAAction(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if user.IsBot {
		pkg.Error(w, pkg.ErrForbidden)
		return
	}
	if h.mfa == nil {
		pkg.ErrorWithCode(w, 503, "MFA unavailable", "MFA_UNAVAILABLE")
		return
	}
	var req struct {
		ExpectedUserID string `json:"expected_user_id"`
		Password       string `json:"password"`
		Code           string `json:"code"`
		SetupID        string `json:"setup_id"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithCode(w, 400, "invalid request body", "VALIDATION_FAILED")
		return
	}
	if req.ExpectedUserID != user.ID {
		pkg.ErrorWithCode(w, 409, "account changed; sign in again", "ACCOUNT_MISMATCH")
		return
	}
	var data any
	var err error
	switch r.PathValue("action") {
	case "cancel":
		err = h.mfa.Cancel(r.Context(), user.ID, req.SetupID)
		data = map[string]bool{"cancelled": true}
	case "setup":
		data, err = h.mfa.Begin(r.Context(), user.ID, req.Password)
	case "confirm":
		var codes []string
		codes, err = h.mfa.Confirm(r.Context(), user.ID, req.SetupID, req.Code)
		data = map[string]any{"recovery_codes": codes}
	case "recovery":
		var codes []string
		codes, err = h.mfa.Regenerate(r.Context(), user.ID, req.Password, req.Code)
		data = map[string]any{"recovery_codes": codes}
	case "disable":
		err = h.mfa.Disable(r.Context(), user.ID, req.Password, req.Code)
		data = map[string]bool{"enabled": false}
	default:
		pkg.Error(w, pkg.ErrNotFound)
		return
	}
	if err != nil {
		if !writeMFAError(w, err) {
			pkg.Error(w, err)
		}
		return
	}
	pkg.JSON(w, 200, data)
}
