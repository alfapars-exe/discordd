package handlers

import (
	"github.com/argeinfina/hichat/pkg"
	"net/http"
)

func (h *GroupDMHandler) SetMuted(w http.ResponseWriter, r *http.Request) {
	user, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if !groupDMAccountMatches(w, r, user) || groupDMRateLimited(w, h.actionLimiter, user.ID, "group settings changes") {
		return
	}
	var req struct {
		Muted *bool `json:"is_muted"`
	}
	if !decodeGroupJSON(w, r, &req) {
		return
	}
	if req.Muted == nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "is_muted is required")
		return
	}
	state, err := h.service.SetMuted(r.Context(), r.PathValue("groupId"), user.ID, *req.Muted)
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, state)
}
