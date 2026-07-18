package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/config"
)

// pingFn adapts a function to the dbPinger interface used by readyHandler.
type pingFn func(ctx context.Context) error

func (f pingFn) PingContext(ctx context.Context) error { return f(ctx) }

// decodeHealthBody unmarshals a recorded health/ready response, failing the
// test on malformed JSON so every caller doesn't repeat the error check.
func decodeHealthBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body: %v", err)
	}
	return body
}

// healthHandler is a shallow liveness check: always 200, no dependency probing,
// so the Docker HEALTHCHECK never restarts a live process over a remote-DB blip.
func TestHealthHandler_ShallowAlwaysOK(t *testing.T) {
	cache := &readinessCache{}
	cache.store(readinessSnapshot{Ready: true, DBOK: true, CheckedAt: time.Now()})

	rec := httptest.NewRecorder()
	healthHandler(cache)(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decodeHealthBody(t, rec)
	if body["status"] != "ok" {
		t.Fatalf("status field = %v, want ok", body["status"])
	}
	checks, _ := body["checks"].(map[string]any)
	if checks["database"] != true {
		t.Fatalf("checks.database = %v, want true", checks["database"])
	}
}

// A degraded readiness cache must surface in the BODY without ever changing the
// status code: Docker gates container restarts on this endpoint, and a restart
// cannot heal a remote-DB outage.
func TestHealthHandler_DegradedCacheStill200(t *testing.T) {
	cache := &readinessCache{}
	cache.store(readinessSnapshot{Ready: false, DBOK: false, LiveKitOK: true, CheckedAt: time.Now()})

	rec := httptest.NewRecorder()
	healthHandler(cache)(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 even when degraded", rec.Code)
	}
	body := decodeHealthBody(t, rec)
	if body["status"] != "degraded" {
		t.Fatalf("status field = %v, want degraded", body["status"])
	}
	checks, _ := body["checks"].(map[string]any)
	if checks["database"] != false {
		t.Fatalf("checks.database = %v, want false", checks["database"])
	}
	if checks["livekit_configured"] != true {
		t.Fatalf("checks.livekit_configured = %v, want true", checks["livekit_configured"])
	}
}

// Before the background checker has completed its first poll there is nothing
// to report — the endpoint stays "ok" and says so explicitly rather than
// inventing a degraded verdict from a zero-value snapshot.
func TestHealthHandler_BeforeFirstPoll(t *testing.T) {
	rec := httptest.NewRecorder()
	healthHandler(&readinessCache{})(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decodeHealthBody(t, rec)
	if body["status"] != "ok" {
		t.Fatalf("status field = %v, want ok", body["status"])
	}
	checks, _ := body["checks"].(map[string]any)
	if checks["readiness_polled"] != false {
		t.Fatalf("checks.readiness_polled = %v, want false", checks["readiness_polled"])
	}
}

func TestReadyHandler_DBUp(t *testing.T) {
	h := readyHandler(pingFn(func(context.Context) error { return nil }), &config.Config{})

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/api/ready", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decodeHealthBody(t, rec)
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

// The background checker must publish its verdict into the cache that
// /api/health reads, priming it on the very first poll (not one interval late).
func TestReadinessChecker_PrimesCacheImmediately(t *testing.T) {
	cache := &readinessCache{}
	stop := startReadinessChecker(
		pingFn(func(context.Context) error { return errors.New("down") }),
		&config.Config{}, cache, time.Hour, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)),
	)
	stop()

	snap, polled := cache.load()
	if !polled {
		t.Fatal("cache not polled; the checker must prime it before the first tick")
	}
	if snap.Ready || snap.DBOK {
		t.Fatalf("snapshot = %+v, want not-ready with DBOK=false", snap)
	}
}

// Only readiness TRANSITIONS get logged. A per-poll line at 30s intervals would
// drown the slog stream, which is the only alert source on a single-instance
// HF Space. Poll outcomes are keyed on the probe counter (not wall-clock), so
// the expected transition count is deterministic regardless of timer jitter.
func TestReadinessChecker_LogsTransitionsOnly(t *testing.T) {
	const (
		degradedFrom = 4 // probes 4..6 fail
		degradedTo   = 6
		minProbes    = 9 // ...so probe 7+ recovers, giving exactly 2 transitions
	)

	var probes atomic.Int32
	ping := pingFn(func(context.Context) error {
		n := probes.Add(1)
		if n >= degradedFrom && n <= degradedTo {
			return errors.New("db unreachable")
		}
		return nil
	})

	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	cache := &readinessCache{}
	stop := startReadinessChecker(ping, &config.Config{}, cache, time.Millisecond, logger)

	deadline := time.Now().Add(10 * time.Second)
	for probes.Load() < minProbes {
		if time.Now().After(deadline) {
			stop()
			t.Fatalf("only %d probes ran before deadline; want >= %d", probes.Load(), minProbes)
		}
		time.Sleep(time.Millisecond)
	}
	stop() // blocks until the checker goroutine has exited, so buf is safe to read

	lines := 0
	degraded, recovered := 0, 0
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		lines++
		switch {
		case strings.Contains(line, "readiness degraded"):
			degraded++
		case strings.Contains(line, "readiness recovered"):
			recovered++
		}
	}

	if degraded != 1 || recovered != 1 {
		t.Fatalf("degraded=%d recovered=%d, want 1 and 1 after %d probes; log:\n%s",
			degraded, recovered, probes.Load(), buf.String())
	}
	if lines != 2 {
		t.Fatalf("logged %d line(s) across %d probes, want exactly 2 (one per transition); log:\n%s",
			lines, probes.Load(), buf.String())
	}
}

// A healthy first poll stays silent — logging "readiness recovered" at every
// boot would make the transition signal meaningless.
func TestReadinessChecker_HealthyBootIsSilent(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	stop := startReadinessChecker(
		pingFn(func(context.Context) error { return nil }),
		&config.Config{}, &readinessCache{}, time.Hour, logger,
	)
	stop()

	if buf.Len() != 0 {
		t.Fatalf("healthy boot logged %q, want silence", buf.String())
	}
}
