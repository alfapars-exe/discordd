package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

// RemoveApplication permanently retires one automation identity owned by the
// signed-in human. Shared messages and attachments remain attributed to the
// anonymized identity; credentials, owner linkage, memberships, and personal
// profile data are removed transactionally by the repository.
func (h *AuthHandler) RemoveApplication(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, sid, ok := sessionActor(w, r)
	if !ok {
		return
	}
	var req struct {
		ExpectedUserID        string `json:"expected_user_id"`
		ExpectedApplicationID string `json:"expected_application_id"`
		Password              string `json:"password"`
		Code                  string `json:"code"`
		Confirm               bool   `json:"confirm"`
		ConfirmText           string `json:"confirm_text"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	if req.ExpectedUserID != user.ID {
		pkg.ErrorWithCode(w, http.StatusConflict, "account changed; sign in again", "ACCOUNT_MISMATCH")
		return
	}
	botID := r.PathValue("botID")
	if botID == "" || req.ExpectedApplicationID != botID {
		pkg.ErrorWithCode(w, http.StatusConflict, "application changed; reload before removing", "APPLICATION_MISMATCH")
		return
	}
	if !req.Confirm || req.ConfirmText != "REMOVE" || req.Password == "" || botID == user.ID {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	manager, ok := h.authService.(interface {
		RemoveApplication(context.Context, string, string, string, string, string) error
	})
	if !ok {
		pkg.ErrorWithCode(w, http.StatusServiceUnavailable, "application removal unavailable", "APPLICATION_REMOVAL_UNAVAILABLE")
		return
	}
	if err := manager.RemoveApplication(r.Context(), user.ID, sid, botID, req.Password, req.Code); err != nil {
		switch {
		case errors.Is(err, repository.ErrDeletionOwnsServers):
			pkg.ErrorWithCode(w, http.StatusConflict, "transfer application-owned servers first", "APPLICATION_OWNS_SERVERS")
		case errors.Is(err, repository.ErrDeletionOwnsBots):
			pkg.ErrorWithCode(w, http.StatusConflict, "transfer or remove child applications first", "APPLICATION_OWNS_APPLICATIONS")
		case errors.Is(err, repository.ErrDeletionAdmin):
			pkg.ErrorWithCode(w, http.StatusConflict, "application cannot hold platform administration", "APPLICATION_IS_PLATFORM_ADMIN")
		default:
			if !writeMFAError(w, err) {
				pkg.Error(w, err)
			}
		}
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{
		"removed":                true,
		"shared_history":         "retained",
		"personal_asset_cleanup": "queued",
	})
}
