package main

// Health/readiness endpoints and the periodic runtime-stats logger.

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"runtime"
	"sync"
	"time"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/ws"
)

// processStart records process boot time, surfaced as uptime in /api/health.
var processStart = time.Now()

// writeHealthJSON writes v as a raw JSON object with the given status. The
// health/ready endpoints use their own schema rather than the pkg.APIResponse
// envelope so external monitors and the Docker HEALTHCHECK see a stable,
// self-describing shape (the legacy /api/health body was unwrapped too).
func writeHealthJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// healthHandler is the liveness endpoint, and it ALWAYS returns 200 whenever
// the HTTP layer is up. The Docker HEALTHCHECK (curl -fsS /api/health) gates
// container restarts off this, and a restart cannot heal a remote-Turso
// outage — coupling the status code to dependency health would only produce
// restart flapping on a transient blip.
//
// The handler itself still does no I/O: it reports the last snapshot taken by
// the background readiness checker, so `status` degrades to "degraded" (with
// per-check detail) for monitors that read the body, while the restart gate
// stays deliberately shallow. /api/ready remains the strict, request-time
// probe that answers with 503.
func healthHandler(cache *readinessCache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := "ok"
		snap, polled := cache.load()
		checks := map[string]any{"readiness_polled": polled}
		if polled {
			checks["database"] = snap.DBOK
			checks["livekit_configured"] = snap.LiveKitOK
			checks["last_checked_seconds_ago"] = int(time.Since(snap.CheckedAt).Seconds())
			if !snap.Ready {
				status = "degraded"
			}
		}
		writeHealthJSON(w, http.StatusOK, map[string]any{
			"status":         status,
			"service":        "hichat",
			"uptime_seconds": int(time.Since(processStart).Seconds()),
			"checks":         checks,
		})
	}
}

// readinessSnapshot is one deep-check result: what was probed, the verdict, and
// when it was taken (so /api/health can report snapshot age and a reader can
// tell "healthy" from "stale").
type readinessSnapshot struct {
	Ready     bool // overall verdict — currently DBOK, the one hard dependency
	DBOK      bool
	LiveKitOK bool
	CheckedAt time.Time
}

// readinessCache holds the most recent snapshot produced by
// startReadinessChecker. Written by exactly one goroutine, read by every
// /api/health request, so a plain RWMutex is both sufficient and cheaper to
// reason about than an atomic dance over a multi-field struct.
//
// The zero value is valid and reports "not polled yet".
type readinessCache struct {
	mu     sync.RWMutex
	snap   readinessSnapshot
	polled bool
}

func (c *readinessCache) store(snap readinessSnapshot) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.snap, c.polled = snap, true
}

// load returns the cached snapshot and whether a poll has ever completed.
// Nil-safe so a handler wired without a checker degrades to "not polled"
// instead of panicking.
func (c *readinessCache) load() (readinessSnapshot, bool) {
	if c == nil {
		return readinessSnapshot{}, false
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snap, c.polled
}

const (
	// readinessProbeTimeout bounds a single dependency probe. Matches the
	// request-time budget in readyHandler.
	readinessProbeTimeout = 2 * time.Second
	// readinessCheckInterval — how often the background checker re-probes.
	// Fast enough that /api/health reflects an outage within a monitor's
	// scrape window, slow enough to be free.
	readinessCheckInterval = 30 * time.Second
)

// probeReadiness runs one deep dependency check. LiveKit is reported but does
// not gate the verdict: a Space with no LiveKit credentials serves text chat
// perfectly well, so only the DB is a hard dependency (same rule as readyHandler).
func probeReadiness(db dbPinger, cfg *config.Config) readinessSnapshot {
	ctx, cancel := context.WithTimeout(context.Background(), readinessProbeTimeout)
	defer cancel()

	dbOK := db.PingContext(ctx) == nil
	return readinessSnapshot{
		Ready:     dbOK,
		DBOK:      dbOK,
		LiveKitOK: cfg.LiveKit.APIKey != "" && cfg.LiveKit.APISecret != "",
		CheckedAt: time.Now(),
	}
}

// startReadinessChecker polls the deep readiness checks on `interval` and
// publishes each result into cache, where /api/health picks it up without
// doing any request-time I/O. Mirrors startRuntimeStatsLogger's shape.
//
// Only readiness TRANSITIONS are logged: a line every interval would be pure
// noise in the slog stream, which is the alert source on a single-instance HF
// Space. Boot is assumed ready, so a healthy start is silent and a start that
// comes up degraded reports itself once.
//
// Returns a stop func that blocks until the goroutine has exited (bounded by
// readinessProbeTimeout if a probe is in flight), so shutdown never races a
// half-finished poll.
func startReadinessChecker(db dbPinger, cfg *config.Config, cache *readinessCache, interval time.Duration, logger *slog.Logger) func() {
	stop := make(chan struct{})
	done := make(chan struct{})

	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		wasReady := true
		poll := func() {
			snap := probeReadiness(db, cfg)
			cache.store(snap)
			wasReady = logReadinessTransition(logger, wasReady, snap)
		}

		// Prime the cache before the first tick so /api/health carries real
		// data within milliseconds of boot rather than one interval later.
		poll()

		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				poll()
			}
		}
	}()

	return func() {
		close(stop)
		<-done
	}
}

// logReadinessTransition emits a line only when the verdict flips, and returns
// the value to compare the next poll against.
func logReadinessTransition(logger *slog.Logger, wasReady bool, snap readinessSnapshot) bool {
	if wasReady == snap.Ready {
		return wasReady
	}
	if snap.Ready {
		logger.Info("readiness recovered", "database", snap.DBOK, "livekit_configured", snap.LiveKitOK)
	} else {
		logger.Warn("readiness degraded", "database", snap.DBOK, "livekit_configured", snap.LiveKitOK)
	}
	return snap.Ready
}

// dbPinger is the subset of *sql.DB the readiness probe needs, declared as an
// interface so the handler is unit-testable without a real database.
type dbPinger interface {
	PingContext(ctx context.Context) error
}

// readyHandler is a DEEP readiness check: it pings the database (the one hard
// dependency) within a short timeout and reports per-check detail. DB reachable
// → 200, otherwise 503 so a readiness-aware monitor can route around it without
// triggering the liveness-based container restart.
func readyHandler(db dbPinger, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		dbOK := db.PingContext(ctx) == nil

		status, code := "ready", http.StatusOK
		if !dbOK {
			status, code = "degraded", http.StatusServiceUnavailable
		}

		writeHealthJSON(w, code, map[string]any{
			"status":         status,
			"service":        "hichat",
			"uptime_seconds": int(time.Since(processStart).Seconds()),
			"checks": map[string]any{
				"database":           dbOK,
				"livekit_configured": cfg.LiveKit.APIKey != "" && cfg.LiveKit.APISecret != "",
			},
		})
	}
}

// startRuntimeStatsLogger logs a periodic snapshot of process runtime metrics
// (goroutines, heap, DB pool, online users) through slog. On a single-instance
// HF Space there is no metrics scraper, so the structured log stream is the
// telemetry sink — these lines can be queried/aggregated by a log backend.
// Returns a stop func to halt the ticker during graceful shutdown.
func startRuntimeStatsLogger(hub *ws.Hub, db *database.DB, interval time.Duration) func() {
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		logger := logx.Component("metrics")
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				var mem runtime.MemStats
				runtime.ReadMemStats(&mem)
				s := db.Conn.Stats()
				logger.Info("runtime stats",
					"goroutines", runtime.NumGoroutine(),
					"heap_alloc_bytes", mem.HeapAlloc,
					"online_users", len(hub.GetOnlineUserIDs()),
					"db_open_conns", s.OpenConnections,
					"db_in_use", s.InUse,
					"db_idle", s.Idle,
					"db_wait_count", s.WaitCount,
					"uptime_seconds", int(time.Since(processStart).Seconds()),
				)
			}
		}
	}()
	return func() { close(stop) }
}
