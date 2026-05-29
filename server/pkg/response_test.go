package pkg

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestError_5xxHidesInternalDetail verifies that an unmapped (5xx) error does
// not leak its internal message to the client (CWE-209). The wrapped error
// chain on a 500 often contains DB driver text, file paths, or query
// fragments that must not reach the caller. Audit 2026-05-29 (F-3).
func TestError_5xxHidesInternalDetail(t *testing.T) {
	rr := httptest.NewRecorder()
	internal := fmt.Errorf("query failed: %w",
		errors.New("dial tcp 10.0.0.1:5432: connection refused"))

	Error(rr, internal)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rr.Code)
	}

	var resp APIResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if resp.Success {
		t.Errorf("Success = true, want false")
	}
	if resp.Error != "internal server error" {
		t.Errorf("Error = %q, want generic %q", resp.Error, "internal server error")
	}
	// Defense-in-depth assertion: no fragment of the internal chain leaked.
	for _, leak := range []string{"dial tcp", "connection refused", "10.0.0.1", "query failed"} {
		if strings.Contains(resp.Error, leak) {
			t.Errorf("internal detail %q leaked to client in %q", leak, resp.Error)
		}
	}
}

// TestError_4xxKeepsClientSafeMessage verifies domain (4xx) errors are still
// returned verbatim — they carry intentional, client-safe messages and must
// not be swallowed by the 5xx generic-message path.
func TestError_4xxKeepsClientSafeMessage(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantSubstr string
	}{
		{"bad request", fmt.Errorf("%w: password too short", ErrBadRequest), http.StatusBadRequest, "password too short"},
		{"unauthorized", fmt.Errorf("%w: invalid username or password", ErrUnauthorized), http.StatusUnauthorized, "invalid username or password"},
		{"forbidden", fmt.Errorf("%w: insufficient permissions", ErrForbidden), http.StatusForbidden, "insufficient permissions"},
		{"not found", ErrNotFound, http.StatusNotFound, "not found"},
		{"conflict", fmt.Errorf("%w: taken", ErrAlreadyExists), http.StatusConflict, "taken"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			Error(rr, tc.err)
			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", rr.Code, tc.wantStatus)
			}
			var resp APIResponse
			if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if resp.Success {
				t.Errorf("Success = true, want false")
			}
			if !strings.Contains(resp.Error, tc.wantSubstr) {
				t.Errorf("Error = %q, want substring %q", resp.Error, tc.wantSubstr)
			}
		})
	}
}

// TestError_ErrInternalAlsoHidden verifies an explicitly-wrapped ErrInternal
// (which maps to 500) is also redacted, not just the unmapped default.
func TestError_ErrInternalAlsoHidden(t *testing.T) {
	rr := httptest.NewRecorder()
	Error(rr, fmt.Errorf("%w: secret backend host db-primary.internal", ErrInternal))

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rr.Code)
	}
	var resp APIResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if strings.Contains(resp.Error, "db-primary.internal") {
		t.Errorf("internal host leaked to client: %q", resp.Error)
	}
}
