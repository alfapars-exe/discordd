package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type ClipRecordingHandler struct{ service services.ClipRecordingService }

func NewClipRecordingHandler(service services.ClipRecordingService) *ClipRecordingHandler {
	return &ClipRecordingHandler{service: service}
}

func clipActor(w http.ResponseWriter, r *http.Request) (*models.User, string, bool) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	serverID, _ := r.Context().Value(ServerIDContextKey).(string)
	if !ok || user == nil || user.IsBot || serverID == "" {
		pkg.Error(w, pkg.ErrUnauthorized)
		return nil, "", false
	}
	return user, serverID, true
}

func (h *ClipRecordingHandler) Consent(w http.ResponseWriter, r *http.Request) {
	user, serverID, ok := clipActor(w, r)
	if !ok {
		return
	}
	result, err := h.service.Snapshot(r.Context(), user.ID, serverID, r.URL.Query().Get("channel_id"))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, result)
}

func (h *ClipRecordingHandler) Start(w http.ResponseWriter, r *http.Request) {
	user, serverID, ok := clipActor(w, r)
	if !ok {
		return
	}
	var req models.StartClipRecordingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ChannelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel_id is required")
		return
	}
	result, err := h.service.Start(r.Context(), user.ID, serverID, req.ChannelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusCreated, result)
}

func (h *ClipRecordingHandler) Stop(w http.ResponseWriter, r *http.Request) {
	user, serverID, ok := clipActor(w, r)
	if !ok {
		return
	}
	var req models.StopClipRecordingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ChannelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := h.service.Stop(r.Context(), user.ID, serverID, req.ChannelID, r.PathValue("recordingId"), req.DurationMS); err != nil {
		pkg.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
