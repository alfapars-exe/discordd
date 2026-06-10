package main

// Health/readiness endpoints and the periodic runtime-stats logger.

import (
	"context"
	"encoding/json"
	"net/http"
	"runtime"
	"time"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/ws"
)

// processStart records process boot time, surfaced as uptime in /api/health.
var processStart = time.Now()

// healthHandler reports liveness/readiness. It pings the database (the one hard
// dependency) within a short timeout: reachable → 200, otherwise 503 so a load
// balancer / orchestrator can act on it. The legacy {"status":"ok"} shape is
// preserved and extended with per-check detail and process uptime.
// writeHealthJSON writes v as a raw JSON object with the given status. The
// health/ready endpoints use their own schema rather than the pkg.APIResponse
// envelope so external monitors and the Docker HEALTHCHECK see a stable,
// self-describing shape (the legacy /api/health body was unwrapped too).
func writeHealthJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// healthHandler is a SHALLOW liveness check: it returns 200 whenever the HTTP
// layer is up and intentionally does NOT touch the DB/LiveKit. The Docker
// HEALTHCHECK (curl -fsS /api/health) gates container restarts off this, so
// coupling it to a transient remote-DB blip would cause restart flapping.
// Deep dependency status lives on /api/ready instead.
func healthHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeHealthJSON(w, http.StatusOK, map[string]any{
			"status":         "ok",
			"service":        "hichat",
			"uptime_seconds": int(time.Since(processStart).Seconds()),
		})
	}
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
