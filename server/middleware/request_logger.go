package middleware

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/google/uuid"
)

type ctxKey string

const requestIDKey ctxKey = "request_id"

// RequestID returns the request ID assigned by RequestLogger for this request,
// or "" if none was set. Handlers and the recover middleware use it to
// correlate log lines belonging to the same request.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// statusRecorder wraps http.ResponseWriter to capture the response status code
// and byte count for the access log. As the outermost middleware, RequestLogger
// creates it, so inner middleware (including Recover's 500) write through it and
// the captured status reflects the final response.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *statusRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

// RequestLogger returns middleware that assigns each request a request_id
// (surfaced via the X-Request-Id response header and the request context) and
// emits one structured access-log line per request at Info level.
//
// The /ws WebSocket upgrade is skipped: those connections are long-lived and
// the ws layer already logs per-message. This is intended as the OUTERMOST
// middleware so it observes the final status set by anything beneath it.
func RequestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/ws" {
				next.ServeHTTP(w, r)
				return
			}

			reqID := uuid.NewString()
			w.Header().Set("X-Request-Id", reqID)
			ctx := context.WithValue(r.Context(), requestIDKey, reqID)

			rec := &statusRecorder{ResponseWriter: w}
			start := time.Now()
			next.ServeHTTP(rec, r.WithContext(ctx))
			if rec.status == 0 {
				rec.status = http.StatusOK
			}

			logger.LogAttrs(ctx, slog.LevelInfo, "http request",
				slog.String("request_id", reqID),
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", rec.status),
				slog.Int("bytes", rec.bytes),
				slog.Int64("duration_ms", time.Since(start).Milliseconds()),
				slog.String("ip", ratelimit.ExtractIP(r)),
			)
		})
	}
}
