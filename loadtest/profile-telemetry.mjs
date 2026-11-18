// Select numeric diagnostics explicitly: app logs, route strings and future
// private columns must not silently enter a published profile report.
export const RUNTIME_TELEMETRY_QUERY = `SELECT coalesce(json_agg(t ORDER BY t.bucket_at), '[]'::json) FROM (
  SELECT bucket_at, goroutines, heap_alloc_bytes, online_users,
    db_open_conns, db_in_use, db_idle, db_wait_count,
    ws_dispatch_total, ws_rate_limit_drops_total,
    http_requests, http_5xx, http_max_latency_ms, http_avg_latency_ms,
    json_build_object(
      'db_max_open', diagnostics::jsonb->'db_max_open',
      'db_wait_count_delta', diagnostics::jsonb->'db_wait_count_delta',
      'db_wait_duration_ms_delta', diagnostics::jsonb->'db_wait_duration_ms_delta'
    ) AS diagnostics
  FROM runtime_telemetry ORDER BY bucket_at LIMIT 21
) t;`;

const counters = ['goroutines', 'heap_alloc_bytes', 'online_users', 'db_open_conns',
  'db_in_use', 'db_idle', 'db_wait_count', 'ws_dispatch_total',
  'ws_rate_limit_drops_total', 'http_requests', 'http_5xx', 'http_max_latency_ms'];
const diagnostics = ['db_max_open', 'db_wait_count_delta', 'db_wait_duration_ms_delta'];
const invalid = () => new Error('Invalid runtime telemetry');

function bucketInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/.test(value)) throw invalid();
  const instant = Date.parse(value.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 19).replace('T', ' ') !== value) throw invalid();
  return instant;
}

function integerFields(source, keys) {
  const result = {};
  for (const key of keys) {
    if (!Number.isSafeInteger(source?.[key]) || source[key] < 0) throw invalid();
    result[key] = source[key];
  }
  return result;
}

export function normalizeRuntimeTelemetry(rows) {
  if (!Array.isArray(rows) || rows.length < 10 || rows.length > 20) throw invalid();
  let previous = -Infinity;
  return rows.map(row => {
    const instant = bucketInstant(row?.bucket_at);
    if (instant <= previous) throw invalid();
    previous = instant;
    const selected = integerFields(row, counters);
    if (!Number.isFinite(row.http_avg_latency_ms) || row.http_avg_latency_ms < 0 ||
      row.http_avg_latency_ms > Number.MAX_SAFE_INTEGER || selected.http_5xx > selected.http_requests) throw invalid();
    return { bucket_at: row.bucket_at, ...selected, http_avg_latency_ms: row.http_avg_latency_ms,
      diagnostics: integerFields(row.diagnostics, diagnostics) };
  });
}

/** Must be awaited by the workload, before resource cleanup can drop the DB. */
export async function collectRuntimeTelemetry({ read, report, now = () => new Date().toISOString() }) {
  const startedAt = now();
  report.runtimeTelemetry = { status: 'collecting', startedAt };
  let rows;
  try { rows = await read(); }
  catch (error) {
    report.runtimeTelemetry = { status: 'failed', startedAt, finishedAt: now(), failureCode: 'read_failed',
      ...(Number.isSafeInteger(error?.status) ? { childExitStatus: error.status } : {}),
      ...(['ENOENT', 'ETIMEDOUT', 'ENOBUFS', 'EPIPE'].includes(error?.code) ? { systemCode: error.code } : {}) };
    throw new Error('Runtime telemetry read failed');
  }
  let selected;
  try { selected = normalizeRuntimeTelemetry(rows); }
  catch {
    report.runtimeTelemetry = { status: 'failed', startedAt, finishedAt: now(), failureCode: 'invalid_data' };
    throw invalid();
  }
  report.runtimeTelemetry = { status: 'completed', startedAt, finishedAt: now(), rows: selected,
    scope: 'Persisted minute buckets read before cleanup; no forced final partial-minute flush, capacity or pool budget acceptance.' };
}
