package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"io"
	"net/http"
)

// Registered only once operational cleanup and the client consent flow are
// available. Cookie state is never changed by this account-bound response.
func (h *AuthHandler) DeleteAccount(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, sid, ok := sessionActor(w, r)
	if !ok {
		return
	}
	var req struct {
		ExpectedUserID string `json:"expected_user_id"`
		Password       string `json:"password"`
		Code           string `json:"code"`
		Confirm        bool   `json:"confirm"`
		ConfirmText    string `json:"confirm_text"`
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
		pkg.ErrorWithCode(w, 409, "account changed; sign in again", "ACCOUNT_MISMATCH")
		return
	}
	if !req.Confirm || req.ConfirmText != "DELETE" || req.Password == "" {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	manager, ok := h.authService.(interface {
		DeleteAccount(context.Context, string, string, string, string) error
	})
	if !ok {
		pkg.ErrorWithCode(w, 503, "account deletion unavailable", "ACCOUNT_DELETION_UNAVAILABLE")
		return
	}
	if err := manager.DeleteAccount(r.Context(), user.ID, sid, req.Password, req.Code); err != nil {
		switch {
		case errors.Is(err, repository.ErrDeletionOwnsServers):
			pkg.ErrorWithCode(w, 409, "transfer owned servers first", "ACCOUNT_OWNS_SERVERS")
		case errors.Is(err, repository.ErrDeletionOwnsBots):
			pkg.ErrorWithCode(w, 409, "transfer or remove applications first", "ACCOUNT_OWNS_APPLICATIONS")
		case errors.Is(err, repository.ErrDeletionAdmin):
			pkg.ErrorWithCode(w, 409, "hand off platform administration first", "ACCOUNT_IS_PLATFORM_ADMIN")
		default:
			if !writeMFAError(w, err) {
				pkg.Error(w, err)
			}
		}
		return
	}
	pkg.JSON(w, 200, map[string]any{"deleted": true, "shared_history": "retained", "personal_asset_cleanup": "queued"})
}
