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
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
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
			// Name kept exactly as "livekit_configured" — an external monitor
			// may already alert on this exact key, and renaming it to make
			// room for the "reachable" distinction below would silently break
			// that alert with no error surfaced here.
			checks["livekit_configured"] = snap.LiveKitOK
			checks["last_checked_seconds_ago"] = int(time.Since(snap.CheckedAt).Seconds())
			if !snap.Ready {
				status = "degraded"
			}
		}
		// livekit_reachable is populated out of band by metricsCollector (its
		// own interval, not startReadinessChecker's probe tick — see
		// readinessCache.ReportLiveKitReachable), so it's read unconditionally
		// here rather than gated behind `polled`.
		checks["livekit_reachable"] = cache.liveKitReachableStatus()
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

	// liveKitReachable tracks whether any platform-managed LiveKit instance
	// has ever been confirmed reachable by metricsCollector's periodic
	// /metrics poll (see ReportLiveKitReachable). Deliberately NOT part of
	// readinessSnapshot: it's written asynchronously on metricsCollector's
	// own interval, not on startReadinessChecker's probe tick, so folding it
	// into the snapshot would let an unrelated probe's store() silently wipe
	// it back to the zero value.
	liveKitReachable bool
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

// ReportLiveKitReachable records that a platform-managed LiveKit instance
// was (or wasn't) reachable on metricsCollector's most recent poll of it —
// satisfies services.LiveKitReachabilityReporter.
//
// Only positive reports are recorded. metricsCollector calls this once per
// platform-managed instance every collection interval (see collectOne), and
// a deployment can have more than one such instance (auto-switch rotation):
// a single unreachable instance must not flip the whole signal false while a
// sibling instance is healthy — "at least one instance OK". There is
// deliberately no path back to false, so an operator reading
// livekit_reachable=false in /api/health can trust it means "never
// confirmed reachable in this process's lifetime," not "was reachable a
// minute ago, then flapped."
//
// Nil-safe (mirrors load()) so main.go can pass this cache into
// initServices before it's fully wired without a nil-pointer risk if a
// future call site races construction.
func (c *readinessCache) ReportLiveKitReachable(ok bool) {
	if c == nil || !ok {
		return
	}
	c.mu.Lock()
	c.liveKitReachable = true
	c.mu.Unlock()
}

// liveKitReachableStatus reads the current flag. Nil-safe like load().
func (c *readinessCache) liveKitReachableStatus() bool {
	if c == nil {
		return false
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.liveKitReachable
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

// runtimeTelemetryPurgeEveryNTicks controls how often startRuntimeStatsLogger
// purges old runtime_telemetry rows, expressed as a tick count rather than a
// duration so it stays correct regardless of the caller's interval. At the
// production interval (1 minute, see main.go) this is a purge every 24
// minutes — cheap (a single indexed DELETE) and frequent enough that the
// table never accumulates more than about a day's worth of rows past the
// retention window.
const runtimeTelemetryPurgeEveryNTicks = 24

// startRuntimeStatsLogger logs a periodic snapshot of process runtime metrics
// (goroutines, heap, DB pool, online users, WS op counters, HTTP request
// stats) through slog, AND persists the same snapshot as one
// runtime_telemetry row (P3.11) so the history survives past the log
// stream's own retention. On a single-instance HF Space there is no metrics
// scraper, so the structured log stream + this table are the telemetry
// sinks. Returns a stop func to halt the ticker during graceful shutdown.
//
// telemetryRepo/httpStats/retentionDays are all used only for the DB side;
// nil telemetryRepo or httpStats degrades gracefully (skips the insert /
// reports zero HTTP stats respectively) rather than panicking, so a test or
// a future stripped-down boot path isn't forced to wire them.
func startRuntimeStatsLogger(hub *ws.Hub, db *database.DB, interval time.Duration, telemetryRepo repository.RuntimeTelemetryRepository, httpStats *httpStatsAggregator, retentionDays int) func() {
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		logger := logx.Component("metrics")
		tick := 0
		for {
			select {
			case <-stop:
				return
			case now := <-ticker.C:
				tick++

				var mem runtime.MemStats
				runtime.ReadMemStats(&mem)
				s := db.Conn.Stats()
				wsStats := hub.Stats()
				var httpRequests, http5xx, httpMaxLatencyMs int64
				var httpAvgLatencyMs float64
				if httpStats != nil {
					httpRequests, http5xx, httpMaxLatencyMs, httpAvgLatencyMs = httpStats.snapshotAndReset()
				}

				logger.Info("runtime stats",
					"goroutines", runtime.NumGoroutine(),
					"heap_alloc_bytes", mem.HeapAlloc,
					"online_users", len(hub.GetOnlineUserIDs()),
					"db_open_conns", s.OpenConnections,
					"db_in_use", s.InUse,
					"db_idle", s.Idle,
					"db_wait_count", s.WaitCount,
					"ws_dispatch_total", wsStats.DispatchCount,
					"ws_rate_limit_drops_total", wsStats.RateLimitDrops,
					"ws_unregister_queue_drops_total", wsStats.QueueUnregisterDrops,
					"ws_unregister_queue_len", wsStats.QueueUnregisterLen,
					"http_requests", httpRequests,
					"http_5xx", http5xx,
					"http_max_latency_ms", httpMaxLatencyMs,
					"http_avg_latency_ms", httpAvgLatencyMs,
					"uptime_seconds", int(time.Since(processStart).Seconds()),
				)

				// Persisted AFTER the slog line above (see doc comment): the log
				// line is the primary, always-available signal; a DB write
				// failure here must not block or skip it.
				if telemetryRepo != nil {
					row := &models.RuntimeTelemetry{
						BucketAt:              now.UTC().Truncate(time.Minute).Format("2006-01-02 15:04:05"),
						Goroutines:            runtime.NumGoroutine(),
						HeapAllocBytes:        mem.HeapAlloc,
						OnlineUsers:           len(hub.GetOnlineUserIDs()),
						DBOpenConns:           s.OpenConnections,
						DBInUse:               s.InUse,
						DBIdle:                s.Idle,
						DBWaitCount:           s.WaitCount,
						WSDispatchTotal:       wsStats.DispatchCount,
						WSRateLimitDropsTotal: wsStats.RateLimitDrops,
						HTTPRequests:          httpRequests,
						HTTP5xx:               http5xx,
						HTTPMaxLatencyMs:      httpMaxLatencyMs,
						HTTPAvgLatencyMs:      httpAvgLatencyMs,
					}
					insertCtx, cancel := context.WithTimeout(context.Background(), readinessProbeTimeout)
					if err := telemetryRepo.Insert(insertCtx, row); err != nil {
						logger.Warn("runtime telemetry insert failed", "err", pkg.ErrText(err))
					}
					cancel()

					if tick%runtimeTelemetryPurgeEveryNTicks == 0 && retentionDays > 0 {
						cutoff := now.Add(-time.Duration(retentionDays) * 24 * time.Hour)
						purgeCtx, purgeCancel := context.WithTimeout(context.Background(), readinessProbeTimeout)
						if deleted, err := telemetryRepo.PurgeOlderThan(purgeCtx, cutoff); err != nil {
							logger.Warn("runtime telemetry purge failed", "err", pkg.ErrText(err))
						} else if deleted > 0 {
							logger.Info("runtime telemetry purged", "count", deleted, "retention_days", retentionDays)
						}
						purgeCancel()
					}
				}
			}
		}
	}()
	return func() { close(stop) }
}
