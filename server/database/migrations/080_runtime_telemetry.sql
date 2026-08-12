-- 080 — Durable runtime telemetry: a minute-bucketed rollup of the process
-- runtime stats that used to only exist as periodic slog lines (health.go
-- startRuntimeStatsLogger), so an operator can see trend history after the
-- log stream has rotated out, not just "whatever is currently in view."
CREATE TABLE IF NOT EXISTS runtime_telemetry (
    bucket_at                TEXT PRIMARY KEY, -- minute bucket, 'YYYY-MM-DD HH:MM:00' (space-separated, matches app_logs/audit_logs created_at format)
    goroutines               INTEGER NOT NULL,
    heap_alloc_bytes         INTEGER NOT NULL,
    online_users             INTEGER NOT NULL,
    db_open_conns            INTEGER NOT NULL,
    db_in_use                INTEGER NOT NULL,
    db_idle                  INTEGER NOT NULL,
    db_wait_count            INTEGER NOT NULL,
    ws_dispatch_total        INTEGER NOT NULL,
    ws_rate_limit_drops_total INTEGER NOT NULL,
    http_requests            INTEGER NOT NULL,
    http_5xx                 INTEGER NOT NULL,
    http_max_latency_ms      INTEGER NOT NULL,
    http_avg_latency_ms      REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_telemetry_bucket ON runtime_telemetry(bucket_at DESC);
