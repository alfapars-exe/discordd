package main

import (
	"sort"
	"sync"
	"time"
)

// All requests feed the same bounded accumulator, irrespective of access-log
// level. Keys are ServeMux templates; IDs and query strings are never keys.
type httpStatsAggregator struct {
	mu                     sync.Mutex
	requests, serverErrs   int64
	maxLatency, sumLatency time.Duration
	routes                 map[string]*routeLatency
}

func (a *httpStatsAggregator) observeLocked(status int, d time.Duration) {
	a.requests++
	if status >= 500 {
		a.serverErrs++
	}
	a.maxLatency = max(a.maxLatency, d)
	a.sumLatency += d
}
func (a *httpStatsAggregator) Observe(status int, d time.Duration) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.observeLocked(status, d)
}
func (a *httpStatsAggregator) ObserveRequest(route string, status int, d time.Duration) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.observeLocked(status, d)
	a.observeRouteLocked(route, status, d)
}

var latencyBounds = [...]int64{25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000}

type routeLatency struct {
	counts           [12]int64
	requests, errors int64
}

func (a *httpStatsAggregator) observeRouteLocked(route string, status int, d time.Duration) {
	if a.routes == nil {
		a.routes = make(map[string]*routeLatency)
	}
	r := a.routes[route]
	if r == nil {
		if len(a.routes) >= 512 {
			route = "other"
		}
		r = a.routes[route]
		if r == nil {
			r = &routeLatency{}
			a.routes[route] = r
		}
	}
	r.requests++
	if status >= 500 {
		r.errors++
	}
	i := len(latencyBounds)
	for j, b := range latencyBounds {
		if d.Milliseconds() <= b {
			i = j
			break
		}
	}
	r.counts[i]++
}
func (a *httpStatsAggregator) snapshotAndReset() (requests, serverErrs, maxLatencyMs int64, avgLatencyMs float64) {
	requests, serverErrs, maxLatencyMs, avgLatencyMs, _ = a.snapshotWindow()
	return
}
func (a *httpStatsAggregator) snapshotWindow() (requests, serverErrs, maxLatencyMs int64, avgLatencyMs float64, routes map[string]any) {
	a.mu.Lock()
	requests, serverErrs, maxLatencyMs = a.requests, a.serverErrs, a.maxLatency.Milliseconds()
	if requests > 0 {
		avgLatencyMs = float64(a.sumLatency.Milliseconds()) / float64(requests)
	}
	raw := a.routes
	a.routes = nil
	a.requests = 0
	a.serverErrs = 0
	a.maxLatency = 0
	a.sumLatency = 0
	a.mu.Unlock()
	return requests, serverErrs, maxLatencyMs, avgLatencyMs, summarizeRoutes(raw)
}

// Persist only the 32 busiest routes plus an exact histogram for all remaining
// routes combined. This bounds per-minute row/log size without losing counts.
func summarizeRoutes(raw map[string]*routeLatency) map[string]any {
	keys := make([]string, 0, len(raw))
	for route := range raw {
		keys = append(keys, route)
	}
	sort.Slice(keys, func(i, j int) bool {
		if raw[keys[i]].requests == raw[keys[j]].requests {
			return keys[i] < keys[j]
		}
		return raw[keys[i]].requests > raw[keys[j]].requests
	})
	out := make(map[string]any, min(len(keys), 33))
	other := &routeLatency{}
	for i, route := range keys {
		r := raw[route]
		if i < 32 && route != "other" {
			out[route] = r.summary()
		} else {
			other.requests += r.requests
			other.errors += r.errors
			for j, n := range r.counts {
				other.counts[j] += n
			}
		}
	}
	if other.requests > 0 {
		out["other"] = other.summary()
	}
	return out
}
func (r *routeLatency) summary() map[string]any {
	quantile := func(percent int64) int64 {
		target := (r.requests*percent + 99) / 100
		var count int64
		for i, n := range r.counts {
			count += n
			if count >= target {
				if i < len(latencyBounds) {
					return latencyBounds[i]
				}
				return -1
			}
		}
		return 0
	}
	return map[string]any{"requests": r.requests, "http_5xx": r.errors, "p50_ms_upper": quantile(50), "p95_ms_upper": quantile(95), "p99_ms_upper": quantile(99)}
}
