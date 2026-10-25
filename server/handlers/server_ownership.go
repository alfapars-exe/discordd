package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// TransferServerOwnership binds consent to both the signed-in account and the
// server being viewed. Membership middleware is not an ownership grant: the
// service/repository additionally require the actual current owner at commit.
func (h *AuthHandler) TransferServerOwnership(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, sid, ok := sessionActor(w, r)
	if !ok {
		return
	}
	var req struct {
		ExpectedUserID   string `json:"expected_user_id"`
		ExpectedServerID string `json:"expected_server_id"`
		TargetUserID     string `json:"target_user_id"`
		Password         string `json:"password"`
		Code             string `json:"code"`
		Confirm          bool   `json:"confirm"`
		ConfirmText      string `json:"confirm_text"`
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
	serverID := r.PathValue("serverId")
	if serverID == "" || req.ExpectedServerID != serverID {
		pkg.ErrorWithCode(w, 409, "server changed; reload before transferring", "SERVER_MISMATCH")
		return
	}
	if !req.Confirm || req.ConfirmText != "TRANSFER" || req.Password == "" || req.TargetUserID == "" || req.TargetUserID == user.ID {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	manager, ok := h.authService.(interface {
		TransferServerOwnership(context.Context, string, string, string, string, string, string) (*models.Server, error)
	})
	if !ok {
		pkg.ErrorWithCode(w, 503, "server ownership transfer unavailable", "SERVER_TRANSFER_UNAVAILABLE")
		return
	}
	server, err := manager.TransferServerOwnership(r.Context(), user.ID, sid, serverID, req.TargetUserID, req.Password, req.Code)
	if err != nil {
		if !writeMFAError(w, err) {
			pkg.Error(w, err)
		}
		return
	}
	pkg.JSON(w, 200, server)
}
