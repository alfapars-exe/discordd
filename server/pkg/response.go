package pkg

import (
	"encoding/json"
	"errors"
	"log"
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
