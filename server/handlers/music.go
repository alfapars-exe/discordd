package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
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
	// playLimiter throttles Play (resource scan 2026-08-02): each call can
	// spawn a ~30s yt-dlp subprocess, so it gets its own per-user budget
	// rather than sharing one with the cheap skip/pause/resume/stop/state
	// commands. See RateLimiters.MusicPlay for the sizing rationale.
	playLimiter *ratelimit.MessageRateLimiter
}

func NewMusicHandler(music services.MusicBotService, perms services.ChannelPermResolver, playLimiter *ratelimit.MessageRateLimiter) *MusicHandler {
	return &MusicHandler{music: music, perms: perms, playLimiter: playLimiter}
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

	if h.playLimiter != nil && !h.playLimiter.Allow(user.ID) {
		retryAfter := h.playLimiter.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many play requests, please wait %s",
				ratelimit.FormatRetryMessage(retryAfter)))
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
	// Scheme allow-list — first line of defense against yt-dlp argument
	// injection. The service layer also passes `--` to yt-dlp so a
	// `--exec "..."` style payload would be treated as a positional URL,
	// but rejecting non-http(s) here means the offender never reaches
	// the subprocess at all (smaller blast radius, no exec spawn cost).
	if !strings.HasPrefix(req.URL, "http://") && !strings.HasPrefix(req.URL, "https://") {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "url must start with http:// or https://")
		return
	}

	if err := h.requirePerm(r, user.ID, channelID, models.PermSpeak); err != nil {
		pkg.Error(w, err)
		return
	}

	tracks, err := h.music.Enqueue(r.Context(), user.ID, channelID, req.URL)
	if err != nil {
		if errors.Is(err, pkg.ErrBadRequest) {
			// URL guard rejection (music_url_guard.go) — client-caused, 400,
			// message is already safe to echo (it never contains resolved
			// IPs or the raw error chain, see validateMusicURLNetwork).
			pkg.Error(w, err)
			return
		}
		// 5xx: never put err in the response body. pkg.ErrText renders an
		// error for logging — it only strips a fixed list of known credential
		// query-params (see pkg/redact.go), so a Turso hostname, SQL
		// fragment, or file path embedded in a driver error would still reach
		// the client. ErrorCtx applies pkg.Error's CWE-209 policy instead: a
		// generic client-facing message, with the real err logged
		// server-side (slog, request-scoped) via ErrText.
		pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to queue track", err)
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
// MusicBotChannelState, or a null body when no bot is active. Used for
// first-paint and reconnect; every subsequent update arrives over the
// WebSocket. We deliberately return 200 + null instead of 404 because the
// client polls this on every voice join — a missing bot is "expected absence"
// rather than a client error, and surfacing it as 404 produces console noise
// on the happy path with nothing meaningful for the caller to do about it.
func (h *MusicHandler) State(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	state := h.music.GetState(channelID)
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
