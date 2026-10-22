// Package handlers — entrance.go: voice-channel entrance sound endpoints.
//
// Upload order is cheapest-first: rate limit, capped multipart parse, size,
// name rules, then the service's sniff + WAV parse. Only the form fields
// file and name are ever read — duration, size and URL are server-derived,
// whatever else the form carries.
package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

const (
	// entranceJSONMaxBytes caps the JSON bodies (a preset is ≤256 bytes).
	entranceJSONMaxBytes = 4 << 10
	// entranceMultipartMax is the multipart parse budget: the 1 MiB clip
	// plus room for the name field and boundaries.
	entranceMultipartMax = models.EntranceMaxUploadBytes + 64<<10
)

// EntranceHandler serves the entrance-sound routes. uploadLimiter is the
// shared per-user upload budget (nil = disabled).
type EntranceHandler struct {
	svc           services.EntranceService
	uploadLimiter *ratelimit.MessageRateLimiter
}

func NewEntranceHandler(svc services.EntranceService, uploadLimiter *ratelimit.MessageRateLimiter) *EntranceHandler {
	return &EntranceHandler{svc: svc, uploadLimiter: uploadLimiter}
}

// entranceErrorCodes pairs each entrance sentinel with its status, a fixed
// client message (CWE-209) and a machine-readable code.
var entranceErrorCodes = []struct {
	err    error
	status int
	msg    string
	code   string
}{
	{models.ErrEntranceNameInvalid, http.StatusBadRequest,
		"name must be 1-32 characters without control or formatting characters", "ENTRANCE_NAME_INVALID"},
	{models.ErrEntranceFileTooLarge, http.StatusBadRequest,
		"entrance sound file is too large (max 1 MiB)", "ENTRANCE_FILE_TOO_LARGE"},
	{models.ErrEntranceInvalidAudio, http.StatusBadRequest,
		"entrance sound must be a 16-bit PCM WAV file", "ENTRANCE_INVALID_AUDIO"},
	{models.ErrEntranceDurationInvalid, http.StatusBadRequest,
		"entrance sound must be between 100 and 5000 ms long", "ENTRANCE_DURATION_INVALID"},
	{models.ErrEntranceLimitReached, http.StatusBadRequest,
		"you have reached the entrance sound limit", "ENTRANCE_LIMIT_REACHED"},
	{models.ErrEntrancePresetInvalid, http.StatusBadRequest,
		"invalid entrance preset", "ENTRANCE_PRESET_INVALID"},
	{models.ErrEntranceScopeInvalid, http.StatusBadRequest,
		"invalid entrance selection", "ENTRANCE_SCOPE_INVALID"},
	{models.ErrEntranceSettingsInvalid, http.StatusBadRequest,
		"invalid entrance settings", "ENTRANCE_SETTINGS_INVALID"},
	{models.ErrEntranceChannelNotVoice, http.StatusBadRequest,
		"channel is not a voice channel", "ENTRANCE_CHANNEL_NOT_VOICE"},
	{models.ErrEntranceSelfMute, http.StatusBadRequest,
		"you cannot mute your own entrance sound", "BAD_REQUEST"},
	{models.ErrEntranceHierarchy, http.StatusForbidden,
		"you cannot moderate this member's entrance sound", "ENTRANCE_HIERARCHY"},
	{models.ErrEntranceSoundNotFound, http.StatusNotFound, "entrance sound not found", "NOT_FOUND"},
	{models.ErrEntranceMemberNotFound, http.StatusNotFound, "member not found", "NOT_FOUND"},
	{models.ErrEntranceChannelNotFound, http.StatusNotFound, "channel not found", "NOT_FOUND"},
	{models.ErrEntranceServerNotFound, http.StatusNotFound, "server not found", "NOT_FOUND"},
}

// writeEntranceError writes err with its fixed message and code when it is
// an entrance sentinel; everything else goes through pkg.Error's sentinel
// mapping (internal errors become a generic 500).
func writeEntranceError(w http.ResponseWriter, err error) {
	for _, c := range entranceErrorCodes {
		if errors.Is(err, c.err) {
			pkg.ErrorWithCode(w, c.status, c.msg, c.code)
			return
		}
	}
	pkg.Error(w, err)
}

func entranceUser(w http.ResponseWriter, r *http.Request) (*models.User, bool) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
	}
	return user, ok
}

func entranceServerID(w http.ResponseWriter, r *http.Request) (string, bool) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return "", false
	}
	return serverID, true
}

// decodeEntranceJSON decodes a small JSON body; false means a 400 was sent.
func decodeEntranceJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, entranceJSONMaxBytes)).Decode(dst); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

// ListMine handles GET /api/users/me/entrance-sounds.
func (h *EntranceHandler) ListMine(w http.ResponseWriter, r *http.Request) {
	user, ok := entranceUser(w, r)
	if !ok {
		return
	}
	resp, err := h.svc.ListMine(r.Context(), user.ID)
	if err != nil {
		writeEntranceError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, resp)
}

// Upload handles POST /api/users/me/entrance-sounds (multipart: file, name).
func (h *EntranceHandler) Upload(w http.ResponseWriter, r *http.Request) {
	user, ok := entranceUser(w, r)
	if !ok {
		return
	}
	if h.uploadLimiter != nil && !h.uploadLimiter.Allow(user.ID) {
		retryAfter := h.uploadLimiter.CooldownSeconds(user.ID)
		w.Header().Set(retryAfterHeader, fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many uploads, please wait %s", ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	if err := pkg.LimitedParseMultipartForm(w, r, entranceMultipartMax); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "file field is required")
		return
	}
	defer file.Close()
	if header.Size > models.EntranceMaxUploadBytes {
		writeEntranceError(w, models.ErrEntranceFileTooLarge)
		return
	}

	sound, err := h.svc.CreateSound(r.Context(), user.ID, formField(r, "name"), file, header)
	if err != nil {
		writeEntranceError(w, err)
		return
	}
	pkg.JSON(w, http.StatusCreated, sound)
}

// Rename handles PATCH /api/users/me/entrance-sounds/{soundId} {name}.
func (h *EntranceHandler) Rename(w http.ResponseWriter, r *http.Request) {
	user, ok := entranceUser(w, r)
	if !ok {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if !decodeEntranceJSON(w, r, &req) {
		return
	}
	sound, err := h.svc.RenameSound(r.Context(), user.ID, r.PathValue("soundId"), req.Name)
	if err != nil {
		writeEntranceError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, sound)
}

// Delete handles DELETE /api/users/me/entrance-sounds/{soundId}.
func (h *EntranceHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user, ok := entranceUser(w, r)
	if !ok {
		return
	}
	if err := h.svc.DeleteSound(r.Context(), user.ID, r.PathValue("soundId")); err != nil {
		writeEntranceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PutSelection handles PUT /api/users/me/entrance-selection.
func (h *EntranceHandler) PutSelection(w http.ResponseWriter, r *http.Request) {
	user, ok := entranceUser(w, r)
	if !ok {
		return
	}
	var req models.PutEntranceSelectionRequest
	if !decodeEntranceJSON(w, r, &req) {
		return
	}
	selections, err := h.svc.PutSelection(r.Context(), user.ID, &req)
	if err != nil {
		writeEntranceError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, selections)
}

// GetSettings handles GET /api/servers/{serverId}/entrance-settings.
func (h *EntranceHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	serverID, ok := entranceServerID(w, r)
	if !ok {
		return
	}
	settings, err := h.svc.GetServerSettings(r.Context(), serverID)
	if err != nil {
		writeEntranceError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, settings)
}

// PatchSettings handles PATCH /api/servers/{serverId}/entrance-settings.
func (h *EntranceHandler) PatchSettings(w http.ResponseWriter, r *http.Request) {
	serverID, ok := entranceServerID(w, r)
	if !ok {
		return
	}
	var req models.PatchServerEntranceSettingsRequest
	if !decodeEntranceJSON(w, r, &req) {
		return
	}
	settings, err := h.svc.PatchServerSettings(r.Context(), serverID, &req)
	if err != nil {
		writeEntranceError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, settings)
}

// SetChannel handles PUT /api/servers/{serverId}/channels/{channelId}/entrance {enabled}.
func (h *EntranceHandler) SetChannel(w http.ResponseWriter, r *http.Request) {
	serverID, ok := entranceServerID(w, r)
	if !ok {
		return
	}
	var req models.SetChannelEntranceRequest
	if !decodeEntranceJSON(w, r, &req) {
		return
	}
	if req.Enabled == nil {
		writeEntranceError(w, models.ErrEntranceSettingsInvalid)
		return
	}
	if err := h.svc.SetChannelEnabled(r.Context(), serverID, r.PathValue("channelId"), *req.Enabled); err != nil {
		writeEntranceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListMutes handles GET /api/servers/{serverId}/entrance-mutes.
func (h *EntranceHandler) ListMutes(w http.ResponseWriter, r *http.Request) {
	serverID, ok := entranceServerID(w, r)
	if !ok {
		return
	}
	ids, err := h.svc.ListMutes(r.Context(), serverID)
	if err != nil {
		writeEntranceError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, models.EntranceMutesResponse{UserIDs: ids})
}

// Mute handles PUT /api/servers/{serverId}/entrance-mutes/{userId}.
func (h *EntranceHandler) Mute(w http.ResponseWriter, r *http.Request) {
	h.setMute(w, r, true)
}

// Unmute handles DELETE /api/servers/{serverId}/entrance-mutes/{userId}.
func (h *EntranceHandler) Unmute(w http.ResponseWriter, r *http.Request) {
	h.setMute(w, r, false)
}

func (h *EntranceHandler) setMute(w http.ResponseWriter, r *http.Request, muted bool) {
	user, ok := entranceUser(w, r)
	if !ok {
		return
	}
	serverID, ok := entranceServerID(w, r)
	if !ok {
		return
	}
	if err := h.svc.SetMute(r.Context(), serverID, user.ID, r.PathValue("userId"), muted); err != nil {
		writeEntranceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
