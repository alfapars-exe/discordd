package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

var musicHandlerLogger = logx.Component("handler.music")

// playWriteDeadline is Play's per-response write deadline. The client gives
// up at 50 s, so the server must be able to answer before that.
const playWriteDeadline = 45 * time.Second
const maxMusicQueueMutationItems = 200

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
	search      func(context.Context, string) ([]models.MusicTrack, error)
	access      MusicAccessDependencies
}

func NewMusicHandler(music services.MusicBotService, perms services.ChannelPermResolver, playLimiter *ratelimit.MessageRateLimiter, access ...MusicAccessDependencies) *MusicHandler {
	h := &MusicHandler{music: music, perms: perms, playLimiter: playLimiter, search: services.SearchMusicTracks}
	if len(access) > 0 {
		h.access = access[0]
	}
	return h
}

// Search — GET .../music/search?q=. Returns up to five selectable YouTube
// results and never joins the voice room or mutates the queue.
func (h *MusicHandler) Search(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	if h.playLimiter != nil && !h.playLimiter.Allow(user.ID) {
		retryAfter := h.playLimiter.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "too many music searches, please wait")
		return
	}
	channelID := r.PathValue("channelId")
	if err := h.requirePerm(r, user.ID, channelID, models.PermSpeak); err != nil {
		pkg.Error(w, err)
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" || len([]rune(query)) > 100 {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "search query must be 1-100 characters")
		return
	}
	tracks, err := h.search(r.Context(), query)
	if err != nil {
		if errors.Is(err, pkg.ErrBadRequest) {
			pkg.Error(w, err)
			return
		}
		if code := services.MusicErrorCode(err); code != "" {
			pkg.ErrorWithCode(w, http.StatusBadGateway, "failed to search YouTube", code)
			return
		}
		pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to search YouTube", err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string][]models.MusicTrack{"results": tracks})
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
	if h.guardedCommand(w, r, "play", models.PermSpeak) {
		return
	}
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

	// Enqueue can outlive the server-wide WriteTimeout (main.go): yt-dlp
	// extraction alone may take up to 30 s, plus the LiveKit connect on a
	// channel's first /play. When it did, the track was queued but the
	// response was lost. Extend this one response's deadline instead of
	// raising the global timeout. Failure is logged, not fatal: the request
	// still works whenever Enqueue is fast enough.
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(playWriteDeadline)); err != nil {
		musicHandlerLogger.Warn("play: extend write deadline failed", slog.String("err", pkg.ErrText(err)))
	}

	tracks, err := h.music.Enqueue(r.Context(), user.ID, channelID, req.URL)
	if err != nil {
		if code := services.MusicErrorCode(err); code != "" {
			musicHandlerLogger.Warn("play: YouTube resolution failed", "code", code, "err", pkg.ErrText(err))
			pkg.ErrorWithCode(w, http.StatusBadGateway, "failed to resolve YouTube track", code)
			return
		}
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
	if h.guardedCommand(w, r, "skip", models.PermSpeak) {
		return
	}
	h.simpleCommand(w, r, models.PermSpeak, h.music.Skip)
}

// Pause — POST /api/servers/.../music/pause
func (h *MusicHandler) Pause(w http.ResponseWriter, r *http.Request) {
	if h.guardedCommand(w, r, "pause", models.PermSpeak) {
		return
	}
	h.simpleCommand(w, r, models.PermSpeak, h.music.Pause)
}

// Resume — POST /api/servers/.../music/resume
func (h *MusicHandler) Resume(w http.ResponseWriter, r *http.Request) {
	if h.guardedCommand(w, r, "resume", models.PermSpeak) {
		return
	}
	h.simpleCommand(w, r, models.PermSpeak, h.music.Resume)
}

// Stop — POST /api/servers/.../music/stop. Higher gate (ManageChannels) since
// it kicks the bot for everyone listening.
func (h *MusicHandler) Stop(w http.ResponseWriter, r *http.Request) {
	if h.guardedCommand(w, r, "stop", models.PermManageChannels) {
		return
	}
	h.simpleCommand(w, r, models.PermManageChannels, h.music.Stop)
}

type reorderMusicQueueRequest struct {
	QueueItemIDs     []string `json:"queue_item_ids"`
	ExpectedRevision uint64   `json:"expected_revision"`
}

type musicRevisionRequest struct {
	ExpectedRevision uint64 `json:"expected_revision"`
}

type repeatMusicRequest struct {
	Mode string `json:"mode"`
}

type seekMusicRequest struct {
	Seconds int `json:"seconds"`
}

func (h *MusicHandler) RemoveQueueItem(w http.ResponseWriter, r *http.Request) {
	if h.guardedCommand(w, r, "remove", models.PermSpeak) {
		return
	}
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	channelID, itemID := r.PathValue("channelId"), r.PathValue("queueItemId")
	if channelID == "" || itemID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel and queue item are required")
		return
	}
	revision, err := strconv.ParseUint(r.URL.Query().Get("revision"), 10, 64)
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "valid revision is required")
		return
	}
	if err := h.requirePerm(r, user.ID, channelID, models.PermSpeak); err != nil {
		pkg.Error(w, err)
		return
	}
	if err := h.music.RemoveQueueItem(channelID, itemID, revision); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *MusicHandler) ReorderQueue(w http.ResponseWriter, r *http.Request) {
	if h.guardedCommand(w, r, "reorder", models.PermSpeak) {
		return
	}
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	channelID := r.PathValue("channelId")
	var req reorderMusicQueueRequest
	if json.NewDecoder(r.Body).Decode(&req) != nil || len(req.QueueItemIDs) > maxMusicQueueMutationItems {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid queue order")
		return
	}
	if err := h.requirePerm(r, user.ID, channelID, models.PermSpeak); err != nil {
		pkg.Error(w, err)
		return
	}
	if err := h.music.ReorderQueue(channelID, req.QueueItemIDs, req.ExpectedRevision); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *MusicHandler) ShuffleQueue(w http.ResponseWriter, r *http.Request) {
	if h.guardedCommand(w, r, "shuffle", models.PermSpeak) {
		return
	}
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	channelID := r.PathValue("channelId")
	var req musicRevisionRequest
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid queue revision")
		return
	}
	if err := h.requirePerm(r, user.ID, channelID, models.PermSpeak); err != nil {
		pkg.Error(w, err)
		return
	}
	if err := h.music.ShuffleQueue(channelID, req.ExpectedRevision); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *MusicHandler) SetRepeatMode(w http.ResponseWriter, r *http.Request) {
	if h.guardedCommand(w, r, "repeat", models.PermSpeak) {
		return
	}
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	channelID := r.PathValue("channelId")
	var req repeatMusicRequest
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid repeat mode")
		return
	}
	if err := h.requirePerm(r, user.ID, channelID, models.PermSpeak); err != nil {
		pkg.Error(w, err)
		return
	}
	if err := h.music.SetRepeatMode(channelID, req.Mode); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *MusicHandler) Seek(w http.ResponseWriter, r *http.Request) {
	if h.guardedCommand(w, r, "seek", models.PermSpeak) {
		return
	}
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	channelID := r.PathValue("channelId")
	var req seekMusicRequest
	if json.NewDecoder(r.Body).Decode(&req) != nil || req.Seconds < 0 {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid seek position")
		return
	}
	if err := h.requirePerm(r, user.ID, channelID, models.PermSpeak); err != nil {
		pkg.Error(w, err)
		return
	}
	if err := h.music.Seek(channelID, req.Seconds); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *MusicHandler) Restore(w http.ResponseWriter, r *http.Request) {
	if h.guardedCommand(w, r, "restore", models.PermSpeak) {
		return
	}
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	channelID := r.PathValue("channelId")
	if err := h.requirePerm(r, user.ID, channelID, models.PermSpeak); err != nil {
		pkg.Error(w, err)
		return
	}
	if err := h.music.Restore(r.Context(), channelID); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
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
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if err := h.requirePerm(r, user.ID, channelID, models.PermViewChannel); err != nil {
		pkg.Error(w, err)
		return
	}
	if reader, ok := h.music.(services.PublicMusicStateReader); ok {
		err := reader.WithPublicMusicState(r.Context(), channelID, func(state *models.MusicBotChannelState) { pkg.JSON(w, http.StatusOK, state) })
		if err != nil {
			pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to read music state", err)
		}
		return
	}
	if reader, ok := h.music.(services.ErrorAwareMusicState); ok {
		state, err := reader.GetStateWithError(r.Context(), channelID)
		if err != nil {
			pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to read music state", err)
			return
		}
		pkg.JSON(w, http.StatusOK, state)
		return
	}
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
	if user, ok := r.Context().Value(UserContextKey).(*models.User); ok && user.IsBot {
		return pkg.ErrForbidden
	}
	if h.access.Channels != nil {
		channel, err := h.access.Channels.GetByID(r.Context(), channelID)
		if err != nil {
			return err
		}
		if channel.Type != models.ChannelTypeVoice || channel.ServerID != r.PathValue("serverId") {
			return pkg.ErrForbidden
		}
	}
	effective, err := h.perms.ResolveChannelPermissions(r.Context(), userID, channelID)
	if err != nil {
		return err
	}
	if !effective.Has(required) || !effective.Has(models.PermViewChannel) {
		return pkg.ErrForbidden
	}
	if required != models.PermViewChannel && h.access.Voice != nil && h.access.Voice.GetUserVoiceChannelID(userID) != channelID {
		// Existing remote moderator control is intentionally limited to Stop.
		if required != models.PermManageChannels || !effective.Has(models.PermManageChannels) {
			return pkg.ErrForbidden
		}
	}
	return nil
}
