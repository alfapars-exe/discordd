package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type VoiceHandler struct {
	voiceService     VoiceHandlerService
	voiceStateFilter VoiceStateSnapshotFilter
}

type VoiceHandlerService interface {
	GenerateToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error)
	GenerateScreenShareToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error)
	GetAllVoiceStates() []models.VoiceState
}

type VoiceStateSnapshotFilter interface {
	FilterVisibleVoiceStates(ctx context.Context, viewerID string, serverIDs []string, states []models.VoiceState) ([]models.VoiceState, error)
}

func NewVoiceHandler(voiceService VoiceHandlerService, filters ...VoiceStateSnapshotFilter) *VoiceHandler {
	h := &VoiceHandler{voiceService: voiceService}
	if len(filters) > 0 {
		h.voiceStateFilter = filters[0]
	}
	return h
}

// Token handles POST /api/servers/{serverId}/voice/token
// Generates a LiveKit JWT for the server's LiveKit instance.
func (h *VoiceHandler) Token(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.VoiceTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.ChannelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel_id is required")
		return
	}

	var displayName string
	if user.DisplayName != nil {
		displayName = *user.DisplayName
	}
	resp, err := h.voiceService.GenerateToken(r.Context(), user.ID, user.Username, displayName, req.ChannelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, resp)
}

// ScreenShareToken handles POST /api/servers/{serverId}/voice/screen-token
// Generates a LiveKit JWT for iOS native screen share (separate identity).
func (h *VoiceHandler) ScreenShareToken(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.VoiceTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.ChannelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel_id is required")
		return
	}

	var displayName string
	if user.DisplayName != nil {
		displayName = *user.DisplayName
	}
	resp, err := h.voiceService.GenerateScreenShareToken(r.Context(), user.ID, user.Username, displayName, req.ChannelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, resp)
}

// VoiceStates handles GET /api/servers/{serverId}/voice/states
// Returns all active voice states (used on connect/reconnect to sync UI).
func (h *VoiceHandler) VoiceStates(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil || user.ID == "" {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "serverId is required")
		return
	}
	if h.voiceStateFilter == nil {
		pkg.ErrorWithMessage(w, http.StatusInternalServerError, "voice state visibility is unavailable")
		return
	}

	states, err := h.voiceStateFilter.FilterVisibleVoiceStates(r.Context(), user.ID, []string{serverID}, h.voiceService.GetAllVoiceStates())
	if err != nil {
		pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to resolve voice state visibility", err)
		return
	}
	pkg.JSON(w, http.StatusOK, states)
}
