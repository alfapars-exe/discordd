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

	mu      sync.Mutex
	buckets map[string]*clientLogBucket // keyed by user ID
}

type clientLogBucket struct {
	tokens float64
	last   time.Time
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

	if !h.allow(user.ID) {
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "rate limited")
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

	message := strings.TrimSpace(req.Message)
	if message == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "message is required")
		return
	}
	if len(message) > maxClientLogMessageLen {
		message = message[:maxClientLogMessageLen]
	}

	// Trim metadata values defensively. A misbehaving client could otherwise
	// pump megabyte stack traces into a single row.
	metadata := make(map[string]string, len(req.Metadata)+1)
	for k, v := range req.Metadata {
		if len(v) > maxMetadataValueLen {
			v = v[:maxMetadataValueLen]
		}
		metadata[k] = v
	}

	uid := user.ID
	h.appLogger.Log(level, models.LogCategoryClient, &uid, nil, message, metadata)

	w.WriteHeader(http.StatusNoContent)
}

// allow runs a per-user token bucket. Returns false when the bucket is empty.
// Bucket map grows unboundedly; this is fine because keys are user IDs and
// the userCache TTL on the auth middleware already implies an upper bound on
// how many distinct users hit the endpoint per unit time. If this ever becomes
// a memory concern, a janitor goroutine that prunes idle buckets is the fix.
func (h *ClientLogHandler) allow(userID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	now := time.Now()
	b, ok := h.buckets[userID]
	if !ok {
		b = &clientLogBucket{tokens: float64(clientLogPerUserBurst), last: now}
		h.buckets[userID] = b
	}

	elapsed := now.Sub(b.last)
	if elapsed > 0 {
		b.tokens += float64(elapsed) / float64(clientLogPerUserRefill)
		if b.tokens > float64(clientLogPerUserBurst) {
			b.tokens = float64(clientLogPerUserBurst)
		}
		b.last = now
	}

	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}
