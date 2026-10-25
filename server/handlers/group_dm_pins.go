package handlers

import (
	"github.com/argeinfina/hichat/pkg"
	"net/http"
)

func (h *GroupDMHandler) ListPinnedMessages(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if !groupDMAccountMatches(w, r, u) {
		return
	}
	items, err := h.service.ListPinnedMessages(r.Context(), r.PathValue("groupId"), u.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"messages": items})
}

func (h *GroupDMHandler) PinMessage(w http.ResponseWriter, r *http.Request) { h.setPinned(w, r, true) }
func (h *GroupDMHandler) UnpinMessage(w http.ResponseWriter, r *http.Request) {
	h.setPinned(w, r, false)
}
func (h *GroupDMHandler) setPinned(w http.ResponseWriter, r *http.Request, pinned bool) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if !groupDMAccountMatches(w, r, u) {
		return
	}
	if groupDMRateLimited(w, h.actionLimiter, u.ID, "group actions") {
		return
	}
	if err := h.service.SetMessagePinned(r.Context(), r.PathValue("groupId"), u.ID, r.PathValue("messageId"), pinned); err != nil {
		pkg.Error(w, err)
		return
	}
	status := "unpinned"
	if pinned {
		status = "pinned"
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"status": status})
}
