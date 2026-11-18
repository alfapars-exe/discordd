package handlers

import (
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
	"net/http"
)

type GroupDMDeviceRosterHandler struct {
	access  services.GroupDMDeviceRosterAccess
	devices dmRosterDeviceLister
}

func NewGroupDMDeviceRosterHandler(access services.GroupDMDeviceRosterAccess, devices dmRosterDeviceLister) *GroupDMDeviceRosterHandler {
	return &GroupDMDeviceRosterHandler{access: access, devices: devices}
}
func (h *GroupDMDeviceRosterHandler) Get(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	epoch, members, err := h.access.GetGroupDeviceRosterMembers(r.Context(), user.ID, r.PathValue("groupId"))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	roster, err := readDeviceRoster(r.Context(), h.devices, members)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, struct {
		*models.DMDeviceRoster
		KeyEpoch int64 `json:"key_epoch"`
	}{roster, epoch})
}
