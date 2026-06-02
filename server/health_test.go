package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/config"
)

// pingFn adapts a function to the dbPinger interface used by readyHandler.
type pingFn func(ctx context.Context) error

func (f pingFn) PingContext(ctx context.Context) error { return f(ctx) }

// healthHandler is a shallow liveness check: always 200, no dependency probing,
// so the Docker HEALTHCHECK never restarts a live process over a remote-DB blip.
func TestHealthHandler_ShallowAlwaysOK(t *testing.T) {
	rec := httptest.NewRecorder()
	healthHandler()(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("status field = %v, want ok", body["status"])
	}
}

func TestReadyHandler_DBUp(t *testing.T) {
	h := readyHandler(pingFn(func(context.Context) error { return nil }), &config.Config{})

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/api/ready", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body: %v", err)
	}
	if body["status"] != "ready" {
		t.Fatalf("status field = %v, want ready", body["status"])
	}
	checks, _ := body["checks"].(map[string]any)
	if checks["database"] != true {
		t.Fatalf("checks.database = %v, want true", checks["database"])
	}
}

func TestReadyHandler_DBDown(t *testing.T) {
	h := readyHandler(pingFn(func(context.Context) error { return errors.New("db unreachable") }), &config.Config{})

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/api/ready", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
