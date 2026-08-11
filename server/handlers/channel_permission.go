package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

// ChannelPermissionHandler handles per-channel permission override endpoints.
// All endpoints require ManageChannels permission, checked server-wide by
// authServerPerm middleware. SetOverride/DeleteOverride additionally enforce
// per-request, channel-scoped checks in the service (N-03): the actor cannot
// grant/deny a bit it doesn't itself hold there, and cannot touch a role at
// or above its own hierarchy position.
type ChannelPermissionHandler struct {
	service services.ChannelPermissionService
}

func NewChannelPermissionHandler(service services.ChannelPermissionService) *ChannelPermissionHandler {
	return &ChannelPermissionHandler{service: service}
}

// ListOverrides handles GET /api/channels/{id}/permissions
func (h *ChannelPermissionHandler) ListOverrides(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context missing")
		return
	}

	overrides, err := h.service.GetOverrides(r.Context(), serverID, channelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, overrides)
}

// SetOverride handles PUT /api/channels/{channelId}/permissions/{roleId}
// Upserts a permission override. allow and deny must not overlap.
// Only channel-level permissions (ChannelOverridablePerms) can be overridden.
// allow=0, deny=0 deletes the override (reverts to inherit).
func (h *ChannelPermissionHandler) SetOverride(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	roleID := r.PathValue("roleId")
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context missing")
		return
	}
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req models.SetOverrideRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.service.SetOverride(r.Context(), serverID, channelID, roleID, actor.ID, &req); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "override updated"})
}

// DeleteOverride handles DELETE /api/channels/{channelId}/permissions/{roleId}
// Removes the override; the role falls back to its global permissions.
func (h *ChannelPermissionHandler) DeleteOverride(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	roleID := r.PathValue("roleId")
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context missing")
		return
	}
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	if err := h.service.DeleteOverride(r.Context(), serverID, channelID, roleID, actor.ID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "override deleted"})
}
