package middleware

import (
	"log/slog"
	"net/http"
	"runtime/debug"

	"github.com/argeinfina/hichat/pkg"
)

// Recover returns middleware that recovers from panics in downstream HTTP
// handlers, logs them with a full stack trace at Error level — which the slog
// Sentry handler forwards to Sentry — and responds 500 instead of letting the
// connection drop. This mirrors the per-connection recovery the ws layer
// already performs in Client.handleEvent (ws/client.go); the HTTP layer
// previously had no equivalent, so a single handler panic could surface as a
// dropped connection with no trace.
func Recover(logger *slog.Logger) func(http.Handler) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				rec := recover()
				if rec == nil {
					return
				}
				// http.ErrAbortHandler is the stdlib's sanctioned way to abort a
				// response mid-flight; propagate it rather than masking it as 500.
				if rec == http.ErrAbortHandler {
					panic(rec)
				}

				logger.LogAttrs(r.Context(), slog.LevelError, "panic recovered in HTTP handler",
					slog.Any("panic", rec),
					slog.String("method", r.Method),
					slog.String("path", r.URL.Path),
					slog.String("request_id", RequestID(r.Context())),
					slog.String("stack", string(debug.Stack())),
				)
				pkg.ErrorWithMessage(w, http.StatusInternalServerError, "internal server error")
			}()

			next.ServeHTTP(w, r)
		})
	}
}
