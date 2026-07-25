package handlers

import (
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type PinHandler struct {
	pinService services.PinService
}

func NewPinHandler(pinService services.PinService) *PinHandler {
	return &PinHandler{pinService: pinService}
}

// ListPins handles GET /api/servers/{serverId}/channels/{id}/pins
func (h *PinHandler) ListPins(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context missing")
		return
	}

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	pins, err := h.pinService.GetPinnedMessages(r.Context(), serverID, channelID, user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, pins)
}

// Pin handles POST /api/servers/{serverId}/channels/{channelId}/messages/{messageId}/pin
// Requires ManageMessages permission.
func (h *PinHandler) Pin(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	messageID := r.PathValue("messageId")
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context missing")
		return
	}

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	pin, err := h.pinService.Pin(r.Context(), serverID, messageID, channelID, user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, pin)
}

// Unpin handles DELETE /api/servers/{serverId}/channels/{channelId}/messages/{messageId}/pin
// Requires ManageMessages permission.
func (h *PinHandler) Unpin(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	messageID := r.PathValue("messageId")
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context missing")
		return
	}

	if err := h.pinService.Unpin(r.Context(), serverID, messageID, channelID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "message unpinned"})
}
