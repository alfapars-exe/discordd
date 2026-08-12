package models

// RuntimeTelemetry is one minute-bucketed rollup of process runtime stats
// (see health.go's startRuntimeStatsLogger, which logs the same values every
// tick to slog — this is the durable copy, surviving past log retention).
type RuntimeTelemetry struct {
	// BucketAt is the minute bucket in "YYYY-MM-DD HH:MM:00" UTC (space-
	// separated, matching app_logs/audit_logs created_at's SQLite DATETIME
	// format) — the table's primary key.
	BucketAt string `json:"bucket_at"`

	Goroutines     int    `json:"goroutines"`
	HeapAllocBytes uint64 `json:"heap_alloc_bytes"`
	OnlineUsers    int    `json:"online_users"`

	DBOpenConns int   `json:"db_open_conns"`
	DBInUse     int   `json:"db_in_use"`
	DBIdle      int   `json:"db_idle"`
	DBWaitCount int64 `json:"db_wait_count"`

	WSDispatchTotal       uint64 `json:"ws_dispatch_total"`
	WSRateLimitDropsTotal uint64 `json:"ws_rate_limit_drops_total"`

	HTTPRequests     int64   `json:"http_requests"`
	HTTP5xx          int64   `json:"http_5xx"`
	HTTPMaxLatencyMs int64   `json:"http_max_latency_ms"`
	HTTPAvgLatencyMs float64 `json:"http_avg_latency_ms"`
}
