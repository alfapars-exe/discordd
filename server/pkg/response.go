package pkg

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"log/slog"
	"net/http"
)

// APIResponse is the standard envelope for all API responses.
type APIResponse struct {
	Success bool   `json:"success"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
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

	message := err.Error()
	if status >= http.StatusInternalServerError {
		log.Printf("[error] %d: %v", status, err)
		message = "internal server error"
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	resp := APIResponse{
		Success: false,
		Error:   message,
	}

	if encErr := json.NewEncoder(w).Encode(resp); encErr != nil {
		http.Error(w, "failed to encode error response", http.StatusInternalServerError)
	}
}

// ErrorCtx is Error's context-aware sibling. Use it when the caller has
// captured an internal err that shouldn't reach the client (unwrappable
// domain errors have generic messages; DB text, sql error strings,
// file paths, and stack fragments must stay server-side) but you still
// want a searchable breadcrumb in the log.
//
// Behavior:
//   - status ≥ 500: log err at Error with request_id + method/path if the
//     ctx carries a *http.Request (via RequestFrom, not yet wired) and
//     return a generic userMsg. If userMsg is empty, defaults to
//     "internal server error" — same shape as Error() so ops parsers
//     don't have to branch.
//   - status < 500: userMsg is returned verbatim (already client-safe).
//
// The err argument is optional. Passing nil is fine — used when the
// caller detected a bad state without a wrapped error.
func ErrorCtx(ctx context.Context, w http.ResponseWriter, status int, userMsg string, err error) {
	if status >= http.StatusInternalServerError {
		reqID := RequestIDFrom(ctx)
		slog.LogAttrs(ctx, slog.LevelError, "server error",
			slog.Int("status", status),
			slog.String("request_id", reqID),
			slog.Any("err", err),
		)
		if userMsg == "" {
			userMsg = "internal server error"
		}
	}
	ErrorWithMessage(w, status, userMsg)
}

func ErrorWithMessage(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	resp := APIResponse{
		Success: false,
		Error:   message,
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
	default:
		return http.StatusInternalServerError
	}
}
