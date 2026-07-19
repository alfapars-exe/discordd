package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/config"
)

// TestCORS_PreflightIncludesAllowCredentials pins the preflight contract the
// desktop shell depends on: a credentialed fetch from app://hichat is only
// allowed by Chromium when the preflight response itself carries
// Access-Control-Allow-Credentials: true. This test also serves as forensic
// evidence for proxy debugging — if prod preflights lack the header while
// this test passes, the response was synthesized by an edge proxy in front
// of the Go server, not by this code.
func TestCORS_PreflightIncludesAllowCredentials(t *testing.T) {
	c, _ := initCORS(&config.Config{})
	handler := c.Handler(http.NotFoundHandler())

	req := httptest.NewRequest(http.MethodOptions, "/api/auth/login", nil)
	req.Header.Set("Origin", "app://hichat")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type, x-hichat-client")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "app://hichat" {
		t.Errorf("Access-Control-Allow-Origin = %q, want app://hichat", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Errorf("Access-Control-Allow-Credentials = %q, want true", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got == "" {
		t.Error("Access-Control-Allow-Headers missing from preflight response")
	}
}
