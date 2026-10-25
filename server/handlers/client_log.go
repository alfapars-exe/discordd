// Package handlers — ClientLogHandler accepts diagnostic logs from the client
// (browser / Electron / Capacitor) and forwards them into AppLogService so they
// land in app_logs alongside server-side logs. Used to diagnose conditions we
// can't observe server-side (screen share start path, Electron renderer/GPU
// crashes, native audio capture failures).
package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

const (
	// maxClientLogBody — hard cap on the JSON body we'll parse.
	// Crash dumps include stack traces but everything we care about fits in 16KB.
	maxClientLogBody = 16 * 1024

	// clientLogPerUserBurst — token bucket capacity per user.
	clientLogPerUserBurst = 10

	// clientLogPerUserRefill — one token replenished per this duration.
	// ~30/min sustained, with room for bursts (e.g. crash report flush at login).
	clientLogPerUserRefill = 2 * time.Second

	// maxClientLogMessageLen — message field is keyed by us in app_logs and
	// shown verbatim in the admin panel. Trim aggressively so a bad client
	// can't blow up the UI.
	maxClientLogMessageLen = 200

	// maxMetadataValueLen — per-metadata-value cap. Stack traces / error
	// messages are the main consumer; 4KB lets us keep useful context while
	// preventing log bloat.
	maxMetadataValueLen = 4096
)

// allowedClientLevels — only accept these three levels from the client to
// keep the log surface predictable. "error" maps to LogLevelError, etc.
var allowedClientLevels = map[string]models.LogLevel{
	"error": models.LogLevelError,
	"warn":  models.LogLevelWarn,
	"info":  models.LogLevelInfo,
}

type ClientLogHandler struct {
	appLogger services.AppLogService

	mu        sync.Mutex
	buckets   map[string]*clientLogBucket // keyed by user ID
	lastPurge time.Time
}

type clientLogBucket struct {
	tokens      float64
	errorTokens float64
	seen        time.Time
	last        time.Time
}

func NewClientLogHandler(appLogger services.AppLogService) *ClientLogHandler {
	return &ClientLogHandler{
		appLogger: appLogger,
		buckets:   make(map[string]*clientLogBucket),
	}
}

// clientLogRequest is the on-wire shape. Kept small and string-typed so the
// client can build it without a generated SDK.
type clientLogRequest struct {
	Level    string            `json:"level"`
	Message  string            `json:"message"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

// Log handles POST /api/client-log.
//
// Behaviour:
//   - Requires auth middleware (user is read from context, written to app_logs).
//   - Body is capped at maxClientLogBody; oversize requests 413.
//   - Level must be one of {error, warn, info}; anything else 400.
//   - Message is trimmed to maxClientLogMessageLen; metadata values to maxMetadataValueLen.
//   - Per-user token bucket; over-limit returns 429 silently (no leak about cadence).
//   - Always returns 204 on success — client logs are best-effort, no body needed.
func (h *ClientLogHandler) Log(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxClientLogBody)

	var req clientLogRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	level, levelOK := allowedClientLevels[strings.ToLower(req.Level)]
	if !levelOK {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid level")
		return
	}

	if !h.allowLevel(user.ID, level == models.LogLevelError) {
		w.Header().Set("Retry-After", "2")
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "rate limited")
		return
	}
	message := strings.TrimSpace(req.Message)
	if message == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "message is required")
		return
	}
	// Redact before trimming: trimming first could cut a credential-shaped
	// value (e.g. `token=abc`) in half and let the truncated half slip past
	// the pattern match.
	message = pkg.RedactSecrets(message)
	if len(message) > maxClientLogMessageLen {
		message = message[:maxClientLogMessageLen]
	}

	// Redact then trim metadata values defensively, same ordering rationale
	// as message above. A misbehaving client could otherwise pump megabyte
	// stack traces (or leaked credentials) into a single row.
	metadata := make(map[string]string, len(req.Metadata)+1)
	for k, v := range req.Metadata {
		if pkg.IsSecretLogKey(k) {
			v = "***"
		} else {
			v = pkg.RedactSecrets(v)
		}
		if len(v) > maxMetadataValueLen {
			v = v[:maxMetadataValueLen]
		}
		metadata[k] = v
	}

	uid := user.ID
	h.appLogger.Log(r.Context(), level, categoryForMessage(message), &uid, nil, message, metadata)

	w.WriteHeader(http.StatusNoContent)
}

// categoryForMessage maps a client log identifier to its admin-panel category
// using the message-name prefix. Without this routing, every client log lands
// in LogCategoryClient and disappears from the existing voice/ws/screen_share
// filter dropdowns. Unrecognised prefixes fall back to LogCategoryClient so
// older messages keep flowing.
func categoryForMessage(message string) models.LogCategory {
	switch {
	case strings.HasPrefix(message, "screen_share_"):
		return models.LogCategoryScreenShare
	case strings.HasPrefix(message, "voice_"),
		strings.HasPrefix(message, "p2p_"):
		return models.LogCategoryVoice
	case strings.HasPrefix(message, "livekit_"):
		return models.LogCategoryLiveKit
	case strings.HasPrefix(message, "auth_"):
		return models.LogCategoryAuth
	case strings.HasPrefix(message, "video_"):
		return models.LogCategoryVideo
	case strings.HasPrefix(message, "ws_"):
		return models.LogCategoryWS
	case strings.HasPrefix(message, "network_"),
		strings.HasPrefix(message, "client_"),
		strings.HasPrefix(message, "electron_"):
		return models.LogCategoryGeneral
	default:
		return models.LogCategoryClient
	}
}

// ERROR may consume its own reserve; INFO can never exhaust that reserve.
func (h *ClientLogHandler) allowLevel(userID string, isError bool) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	if now.Sub(h.lastPurge) >= time.Minute {
		for id, b := range h.buckets {
			if now.Sub(b.seen) > 10*time.Minute {
				delete(h.buckets, id)
			}
		}
		h.lastPurge = now
	}
	b, ok := h.buckets[userID]
	if !ok {
		if len(h.buckets) >= 10000 {
			return false
		}
		b = &clientLogBucket{tokens: float64(clientLogPerUserBurst), errorTokens: 5, last: now, seen: now}
		h.buckets[userID] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	b.seen = now
	if elapsed > 0 {
		b.tokens = min(float64(clientLogPerUserBurst), b.tokens+elapsed/clientLogPerUserRefill.Seconds())
		b.errorTokens = min(5, b.errorTokens+elapsed/5)
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	if isError && b.errorTokens >= 1 {
		b.errorTokens--
		return true
	}
	return false
}
