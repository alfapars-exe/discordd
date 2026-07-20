package pkg

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
)

// APIResponse is the standard envelope for all API responses.
type APIResponse struct {
	Success bool   `json:"success"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
	// Code is a machine-readable error identifier (e.g. "NOT_FOUND"),
	// derived from the domain sentinel via errorCode. Empty on success
	// responses and on the message-only ErrorWithMessage path, which never
	// has a sentinel to derive a code from — omitempty keeps both backward
	// compatible with clients that only read Error.
	Code string `json:"code,omitempty"`
}

func JSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	resp := APIResponse{
		Success: true,
		Data:    data,
	}

	if err := json.NewEncoder(w).Encode(resp); err != nil {
		http.Error(w, "failed to encode response", http.StatusInternalServerError)
	}
}

// Error sends an error response, mapping domain errors to HTTP status codes.
//
// Domain (4xx) errors carry client-safe messages and are returned verbatim.
// For 5xx the wrapped error chain often contains internal detail — DB driver
// text, file paths, query fragments — that must not reach the client
// (CWE-209: information exposure through an error message). Those are logged
// server-side and replaced with a generic message in the response.
func Error(w http.ResponseWriter, err error) {
	status := mapErrorToStatus(err)
	code := errorCode(err)

	message := err.Error()
	if status >= http.StatusInternalServerError {
		// slog (not the std "log" package) so this reaches Sentry — the
		// std-log bridge in pkg/logx/logx.go emits at INFO, and
		// pkg/logx/sentry.go only forwards >= slog.LevelError. No request_id
		// here (Error has no ctx); ErrorCtx below carries one.
		//
		// ErrText, not slog.Any: the Sentry handler copies attrs through
		// a.Value.Any() into sentry.Context, which JSON-marshals an error to
		// `{}` — the message would be lost exactly where it's needed. ErrText
		// also strips DSN credentials out of driver error text.
		slog.LogAttrs(context.Background(), slog.LevelError, "server error",
			slog.Int("status", status),
			slog.String("err", ErrText(err)),
		)
		message = "internal server error"
	}

	writeError(w, status, message, code)
}

// ErrorCtx is Error's context-aware sibling. Use it when the caller has
// captured an internal err that shouldn't reach the client (unwrappable
// domain errors have generic messages; DB text, sql error strings,
// file paths, and stack fragments must stay server-side) but you still
// want a searchable breadcrumb in the log.
//
// Behavior:
//   - status ≥ 500: log err at Error with request_id + method/path (from
//     RequestInfoFrom, wired by middleware.RequestLogger) and return a
//     generic userMsg. If userMsg is empty, defaults to "internal server
//     error" — same shape as Error() so ops parsers don't have to branch.
//   - status < 500: userMsg is returned verbatim (already client-safe).
//
// The err argument is optional. Passing nil is fine — used when the
// caller detected a bad state without a wrapped error.
func ErrorCtx(ctx context.Context, w http.ResponseWriter, status int, userMsg string, err error) {
	code := errorCode(err)
	if status >= http.StatusInternalServerError {
		// The caller chose this 5xx status explicitly and may pass an err that
		// wraps a 4xx sentinel; deriving the code from that err would emit a
		// client signal (e.g. "NOT_FOUND") that contradicts the generic 500
		// body. Force "INTERNAL" so status and code never disagree.
		code = "INTERNAL"
		reqID := RequestIDFrom(ctx)
		method, path := RequestInfoFrom(ctx)
		slog.LogAttrs(ctx, slog.LevelError, "server error",
			slog.Int("status", status),
			slog.String("request_id", reqID),
			slog.String("method", method),
			slog.String("path", path),
			slog.String("err", ErrText(err)),
		)
		if userMsg == "" {
			userMsg = "internal server error"
		}
	}
	writeError(w, status, userMsg, code)
}

// ErrorWithMessage sends a message-only error response with no sentinel to
// derive a Code from — Code stays empty (omitted from the JSON body).
func ErrorWithMessage(w http.ResponseWriter, status int, message string) {
	writeError(w, status, message, "")
}

// writeError is the shared response writer behind Error, ErrorCtx, and
// ErrorWithMessage — the single place that sets headers and encodes the
// APIResponse envelope so all three stay byte-for-byte consistent.
func writeError(w http.ResponseWriter, status int, message, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	resp := APIResponse{
		Success: false,
		Error:   message,
		Code:    code,
	}

	if err := json.NewEncoder(w).Encode(resp); err != nil {
		http.Error(w, "failed to encode error response", http.StatusInternalServerError)
	}
}

func mapErrorToStatus(err error) int {
	switch {
	case errors.Is(err, ErrNotFound):
		return http.StatusNotFound
	case errors.Is(err, ErrUnauthorized):
		return http.StatusUnauthorized
	case errors.Is(err, ErrForbidden):
		return http.StatusForbidden
	case errors.Is(err, ErrAlreadyExists):
		return http.StatusConflict
	case errors.Is(err, ErrBadRequest):
		return http.StatusBadRequest
	case errors.Is(err, ErrDeviceNotFound):
		return http.StatusNotFound
	case errors.Is(err, ErrPrekeyExhausted):
		// Exhausted one-time-prekey pool — the caller can't complete an X3DH
		// session setup right now. Modeled as a conflict (the pool's current
		// state can't satisfy the request) rather than 503: it's not a
		// transient server outage, it's "this device needs to upload more
		// prekeys," which is a client-actionable state conflict.
		return http.StatusConflict
	case errors.Is(err, ErrInvalidKey):
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}

// errorCode returns a machine-readable identifier for err's sentinel,
// mirroring mapErrorToStatus so every pkg.Error/ErrorCtx caller gets a
// stable Code without having to be rewritten individually. Unmatched or nil
// errors (including bare ErrInternal) fall through to "INTERNAL", matching
// mapErrorToStatus's 500 default.
func errorCode(err error) string {
	switch {
	case errors.Is(err, ErrNotFound):
		return "NOT_FOUND"
	case errors.Is(err, ErrUnauthorized):
		return "UNAUTHORIZED"
	case errors.Is(err, ErrForbidden):
		return "FORBIDDEN"
	case errors.Is(err, ErrAlreadyExists):
		return "ALREADY_EXISTS"
	case errors.Is(err, ErrBadRequest):
		return "BAD_REQUEST"
	case errors.Is(err, ErrDeviceNotFound):
		return "NOT_FOUND"
	case errors.Is(err, ErrPrekeyExhausted):
		return "CONFLICT"
	case errors.Is(err, ErrInvalidKey):
		return "INVALID_KEY"
	default:
		return "INTERNAL"
	}
}
