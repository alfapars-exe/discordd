package handlers

import (
	"context"
	"encoding/json"
	"github.com/argeinfina/hichat/pkg"
	"io"
	"net/http"
)

func (h *AuthHandler) DisableAccount(w http.ResponseWriter, r *http.Request) {
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
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	decoder := json.NewDecoder(r.Body)
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
	if !req.Confirm || req.Password == "" {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	manager, ok := h.authService.(interface {
		DisableAccount(context.Context, string, string, string, string) error
	})
	if !ok {
		pkg.ErrorWithCode(w, 503, "account lifecycle unavailable", "ACCOUNT_LIFECYCLE_UNAVAILABLE")
		return
	}
	if err := manager.DisableAccount(r.Context(), user.ID, sid, req.Password, req.Code); err != nil {
		if !writeMFAError(w, err) {
			pkg.Error(w, err)
		}
		return
	}
	// No Set-Cookie: a late response must not clear a replacement sign-in.
	pkg.JSON(w, 200, map[string]bool{"disabled": true})
}
