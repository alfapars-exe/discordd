package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

// MusicHandler — HTTP entry points for the per-channel music bot.
//
// All handlers expect serverID + channelID path parameters. Permission
// resolution lives in the service layer (Enqueue checks PermSpeak; Stop
// checks PermManageChannels). The handler's job is decode → validate →
// delegate → JSON response.
type MusicHandler struct {
	music services.MusicBotService
	perms services.ChannelPermResolver
}

func NewMusicHandler(music services.MusicBotService, perms services.ChannelPermResolver) *MusicHandler {
	return &MusicHandler{music: music, perms: perms}
}

type playRequest struct {
	URL string `json:"url"`
}

type playResponse struct {
	AddedTracks []models.MusicTrack `json:"added_tracks"`
}

// Play — POST /api/servers/{serverId}/channels/{channelId}/music/play
// Body: {"url": "<youtube url>"}. Lazy-starts the bot if absent. Requires
// PermSpeak in the target voice channel (same gate as actually talking).
func (h *MusicHandler) Play(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	channelID := r.PathValue("channelId")
	if channelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel_id is required")
		return
	}

	var req playRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	if req.URL == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "url is required")
		return
	}

	if err := h.requirePerm(r, user.ID, channelID, models.PermSpeak); err != nil {
		pkg.Error(w, err)
		return
	}

	tracks, err := h.music.Enqueue(r.Context(), user.ID, channelID, req.URL)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, playResponse{AddedTracks: tracks})
}

// Skip — POST /api/servers/{serverId}/channels/{channelId}/music/skip
// Drops the currently-playing track; queue advances. PermSpeak gate.
func (h *MusicHandler) Skip(w http.ResponseWriter, r *http.Request) {
	h.simpleCommand(w, r, models.PermSpeak, h.music.Skip)
}

// Pause — POST /api/servers/.../music/pause
func (h *MusicHandler) Pause(w http.ResponseWriter, r *http.Request) {
	h.simpleCommand(w, r, models.PermSpeak, h.music.Pause)
}

// Resume — POST /api/servers/.../music/resume
func (h *MusicHandler) Resume(w http.ResponseWriter, r *http.Request) {
	h.simpleCommand(w, r, models.PermSpeak, h.music.Resume)
}

// Stop — POST /api/servers/.../music/stop. Higher gate (ManageChannels) since
// it kicks the bot for everyone listening.
func (h *MusicHandler) Stop(w http.ResponseWriter, r *http.Request) {
	h.simpleCommand(w, r, models.PermManageChannels, h.music.Stop)
}

// State — GET /api/servers/.../music/state. Returns the channel's current
// MusicBotChannelState (or 404 if no bot is active). Used for first-paint
// and reconnect — every other update arrives over the WebSocket.
func (h *MusicHandler) State(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	state := h.music.GetState(channelID)
	if state == nil {
		pkg.ErrorWithMessage(w, http.StatusNotFound, "no active bot for this channel")
		return
	}
	pkg.JSON(w, http.StatusOK, state)
}

// ─── shared command helper ───

func (h *MusicHandler) simpleCommand(
	w http.ResponseWriter, r *http.Request,
	requiredPerm models.Permission,
	fn func(channelID string) error,
) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	channelID := r.PathValue("channelId")
	if channelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel_id is required")
		return
	}

	if err := h.requirePerm(r, user.ID, channelID, requiredPerm); err != nil {
		pkg.Error(w, err)
		return
	}

	if err := fn(channelID); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *MusicHandler) requirePerm(r *http.Request, userID, channelID string, required models.Permission) error {
	effective, err := h.perms.ResolveChannelPermissions(r.Context(), userID, channelID)
	if err != nil {
		return err
	}
	if !effective.Has(required) {
		return pkg.ErrForbidden
	}
	return nil
}
