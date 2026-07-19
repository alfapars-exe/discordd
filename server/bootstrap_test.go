package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/config"
)

// initCORS is unexported; call the sibling in this package.
func newCORSHandlerForTest(t *testing.T) http.Handler {
	t.Helper()
	// Force non-production so we get deterministic behavior around the
	// localhost dev entries (they're gated by HICHAT_ENV != development).
	t.Setenv("HICHAT_ENV", "development")
	t.Setenv("HICHAT_MOBILE_ORIGINS", "off")
	t.Setenv("CORS_ORIGINS", "")

	cfg := &config.Config{}
	corsHandler, _ := initCORS(cfg)

	// A trivial downstream handler; the CORS middleware wraps it.
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return corsHandler.Handler(inner)
}

func preflight(t *testing.T, h http.Handler, origin string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodOptions, "/api/auth/register", nil)
	req.Header.Set("Origin", origin)
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	// Access-Control-Request-Headers is optional in the CORS spec;
	// omitting keeps the preflight decision purely origin-based, which
	// is what these tests are actually about.

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result()
}

func TestCORS_allowsAppHichatOrigin(t *testing.T) {
	h := newCORSHandlerForTest(t)
	res := preflight(t, h, "app://hichat")

	got := res.Header.Get("Access-Control-Allow-Origin")
	if got != "app://hichat" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, "app://hichat")
	}
	if res.Header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Errorf("credentials not echoed; refresh cookie won't cross the boundary")
	}
	if res.StatusCode != http.StatusNoContent && res.StatusCode != http.StatusOK {
		t.Errorf("preflight status = %d, want 200 or 204", res.StatusCode)
	}
}

func TestCORS_rejectsEvilOrigin(t *testing.T) {
	h := newCORSHandlerForTest(t)
	res := preflight(t, h, "https://evil.example")

	// Rejected preflight leaves the Access-Control-Allow-Origin header
	// unset (rs/cors convention). Browser will block the request.
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Allow-Origin echoed for evil origin: %q", got)
	}
}

func TestCORS_rejectsFileOrigin(t *testing.T) {
	// file:// was the old Electron origin. T1.4 moved the renderer to
	// app://hichat; file:// must no longer be accepted by HTTP CORS
	// (WebSocket handler still allows null/file:// because WS has its
	// own ticket auth — see ws/handler.go).
	h := newCORSHandlerForTest(t)
	res := preflight(t, h, "file://")
	if got := res.Header.Get("Access-Control-Allow-Origin"); got == "file://" {
		t.Errorf("HTTP CORS still echoing file:// origin: %q", got)
	}
}

func TestCORS_allowsCapacitorOrigins(t *testing.T) {
	h := newCORSHandlerForTest(t)
	res := preflight(t, h, "capacitor://localhost")
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "capacitor://localhost" {
		t.Errorf("Allow-Origin = %q, want capacitor://localhost (iOS shell)", got)
	}
}
