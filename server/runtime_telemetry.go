package main

// httpStatsAggregator: in-process accumulator feeding the durable runtime-
// telemetry rollup's HTTP counters (P3.11). Implements
// middleware.HTTPStatsSink; startRuntimeStatsLogger (health.go) reads and
// resets it once per tick so each persisted row reports exactly the
// requests that landed in that window, not a running total.

import (
	"sync"
	"time"
)

// httpStatsAggregator accumulates HTTP request outcomes between
// startRuntimeStatsLogger ticks. Safe for concurrent use — Observe is
// called from every request-handling goroutine via RequestLogger.
type httpStatsAggregator struct {
	mu         sync.Mutex
	requests   int64
	serverErrs int64
	maxLatency time.Duration
	sumLatency time.Duration
}

// Observe satisfies middleware.HTTPStatsSink.
func (a *httpStatsAggregator) Observe(status int, d time.Duration) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.requests++
	if status >= 500 {
		a.serverErrs++
	}
	if d > a.maxLatency {
		a.maxLatency = d
	}
	a.sumLatency += d
}

// snapshotAndReset returns the accumulated window's stats and clears the
// accumulator, so the NEXT tick starts counting from zero rather than
// reporting a running total.
func (a *httpStatsAggregator) snapshotAndReset() (requests, serverErrs, maxLatencyMs int64, avgLatencyMs float64) {
	a.mu.Lock()
	defer a.mu.Unlock()

	requests, serverErrs = a.requests, a.serverErrs
	maxLatencyMs = a.maxLatency.Milliseconds()
	if requests > 0 {
		avgLatencyMs = float64(a.sumLatency.Milliseconds()) / float64(requests)
	}

	a.requests, a.serverErrs, a.maxLatency, a.sumLatency = 0, 0, 0, 0
	return requests, serverErrs, maxLatencyMs, avgLatencyMs
}
