package handlers

import (
	"github.com/argeinfina/hichat/pkg"
	"net/http"
)

func groupExpectedEpoch(w http.ResponseWriter, epoch *int64) ([]int64, bool) {
	if epoch == nil {
		return nil, true
	}
	if *epoch <= 0 {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "key_epoch must be positive")
		return nil, false
	}
	return []int64{*epoch}, true
}

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
		Muted    *bool  `json:"is_muted"`
		KeyEpoch *int64 `json:"key_epoch"`
	}
	if !decodeGroupJSON(w, r, &req) {
		return
	}
	if req.Muted == nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "is_muted is required")
		return
	}
	epoch, valid := groupExpectedEpoch(w, req.KeyEpoch)
	if !valid {
		return
	}
	state, err := h.service.SetMuted(r.Context(), r.PathValue("groupId"), user.ID, *req.Muted, epoch...)
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, state)
}
