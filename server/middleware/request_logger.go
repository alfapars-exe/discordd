package middleware

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/google/uuid"
)

// HTTPStatsSink receives one observation per completed HTTP request (status
// code + total handling duration), for the durable runtime-telemetry
// per-minute rollup (P3.11, see health.go's startRuntimeStatsLogger). Kept
// deliberately minimal — RequestLogger is the single call site, not a new
// middleware — so this doesn't grow into a general metrics-package
// dependency here.
type HTTPStatsSink interface {
	Observe(status int, d time.Duration)
}

type ctxKey string

const requestIDKey ctxKey = "request_id"

// RequestID returns the request ID assigned by RequestLogger for this request,
// or "" if none was set. Handlers and the recover middleware use it to
// correlate log lines belonging to the same request.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// maxInboundRequestIDLen bounds a client-supplied X-Request-Id. Comfortably
// above the 36 characters of the UUIDs we generate, and above the ~32-byte
// trace ids of the common tracing formats, so a legitimate correlation id
// still survives; short enough that it can't bloat a response header or a
// log line.
const maxInboundRequestIDLen = 128

// isSafeRequestID reports whether a client-supplied request id may be echoed
// into a response header and a structured log line.
//
// The alphabet is deliberately narrow — alphanumerics plus the separators
// real-world ids actually use. It excludes every control character (CR and LF
// above all, which would let a caller inject or split log entries and, in a
// header, risk response splitting on a less careful writer) and every
// non-ASCII byte, since nothing that correlates requests needs them.
func isSafeRequestID(id string) bool {
	if id == "" || len(id) > maxInboundRequestIDLen {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z',
			c >= 'A' && c <= 'Z',
			c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == ':':
		default:
			return false
		}
	}
	return true
}

// statusRecorder wraps http.ResponseWriter to capture the response status code
// and byte count for the access log. As the outermost middleware, RequestLogger
// creates it, so inner middleware (including Recover's 500) write through it and
// the captured status reflects the final response.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
	ctx    context.Context
}

func (r *statusRecorder) LogContext() context.Context { return r.ctx }

func (r *statusRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
		r.ResponseWriter.WriteHeader(code)
	}
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

// accessLogLevel picks the level of a request's access-log line. Accepted
// POST /api/client-log calls (204) drop to Debug: every publisher and viewer
// of a screen share posts telemetry there every 10 s, which otherwise buries
// the rest of the access log. Any other status (429 rate limit, 400, 5xx)
// stays at Info so abuse and failures remain visible, and the HTTPStatsSink
// counters see every request regardless of level.
func accessLogLevel(path string, status int) slog.Level {
	if status < 400 && (path == "/api/client-log" || path == "/api/version" || path == "/api/health" || path == "/api/ready" || strings.HasSuffix(path, "/music/state")) {
		return slog.LevelDebug
	}
	return slog.LevelInfo
}

// Unwrap exposes the wrapped writer to http.ResponseController. Without it,
// a handler's NewResponseController(w).SetWriteDeadline (handlers/music.go's
// Play extends its deadline this way) returns http.ErrNotSupported, because
// statusRecorder itself has no SetWriteDeadline method.
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// RequestLogger returns middleware that assigns each request a request_id
// (surfaced via the X-Request-Id response header and the request context) and
// emits one structured access-log line per request, at the level
// accessLogLevel picks (Info except for routine client-log telemetry).
//
// sink, if non-nil, additionally receives an Observe(status, duration) call
// per request — the durable runtime-telemetry rollup's HTTP counters (P3.11)
// feed off this instead of a separate middleware, since statusRecorder
// already computes exactly these two values. nil is fine (e.g. existing
// tests / callers that don't need the aggregation).
//
// WebSocket endpoints are skipped: those connections are long-lived, their
// handlers own diagnostics, and statusRecorder does not implement Hijacker.
// Only the exact registered paths qualify; other internal API paths retain
// ordinary request logging. This is intended as the OUTERMOST
// middleware so it observes the final status set by anything beneath it.
func RequestLogger(logger *slog.Logger, sink HTTPStatsSink) func(http.Handler) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/ws" ||
				r.URL.Path == "/api/internal/music-worker/control" ||
				r.URL.Path == "/api/internal/music-worker/job" {
				next.ServeHTTP(w, r)
				return
			}

			// Honor an inbound X-Request-Id if the client set one (edge
			// proxies, curl scripts, retry loops that want to correlate
			// their side) — but only if it looks like an id. The value is
			// echoed back in a response header AND written into every log
			// line for the request, so an unvalidated one lets any caller
			// inflate our response headers and log volume, and smuggle
			// control characters into the log stream to forge or split
			// entries. Anything oversized or outside the safe alphabet is
			// discarded in favour of a generated id rather than truncated:
			// a mangled id correlates to nothing anyway, and silently
			// reshaping a caller's value is worse than ignoring it.
			reqID := r.Header.Get("X-Request-Id")
			if !isSafeRequestID(reqID) {
				reqID = uuid.NewString()
			}
			w.Header().Set("X-Request-Id", reqID)
			// Store into BOTH keys during the transition: the middleware
			// package's private key (for existing middleware.RequestID
			// callers) and pkg's shared key (so pkg.ErrorCtx can read it
			// without importing middleware). Once all callers migrate to
			// pkg.RequestIDFrom, the private key can go away.
			ctx := context.WithValue(r.Context(), requestIDKey, reqID)
			ctx = pkg.WithRequestID(ctx, reqID)
			// Method + path so pkg.ErrorCtx's 5xx log line can be correlated
			// to an endpoint without pulling the whole *http.Request into ctx.
			ctx = pkg.WithRequestInfo(ctx, r.Method, r.URL.Path)

			ctx = pkg.WithRequestLogState(ctx)
			rec := &statusRecorder{ResponseWriter: w, ctx: ctx}
			start := time.Now()
			request := r.WithContext(ctx)
			next.ServeHTTP(rec, request)
			if rec.status == 0 {
				rec.status = http.StatusOK
				if ctx.Err() != nil {
					rec.status = 499
				} // observation only; never send a synthetic response
			}
			duration := time.Since(start)

			route := request.Pattern
			if route == "" {
				route = "unmatched"
			}
			if combined, ok := sink.(interface {
				ObserveRequest(string, int, time.Duration)
			}); ok {
				combined.ObserveRequest(route, rec.status, duration)
			} else if sink != nil {
				sink.Observe(rec.status, duration)
			}

			if rec.status >= 500 && !pkg.RequestErrorReported(ctx) {
				pkg.DiagnosticError(ctx, rec.status, "HTTP_UNREPORTED", "internal", nil, slog.String("route", route), slog.Int64("duration_ms", duration.Milliseconds()))
			}
			level := accessLogLevel(r.URL.Path, rec.status)
			if duration > 2*time.Second && level < slog.LevelInfo {
				level = slog.LevelInfo
			}
			logger.LogAttrs(ctx, level, "http request",
				slog.String("event_kind", "http_access"),
				slog.String("route", route),
				slog.String("request_id", reqID),
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", rec.status),
				slog.Int("bytes", rec.bytes),
				slog.Int64("duration_ms", duration.Milliseconds()),
				slog.String("ip", ratelimit.ExtractIP(r)),
			)
		})
	}
}
