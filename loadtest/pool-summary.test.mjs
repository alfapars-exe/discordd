import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizePoolTelemetry } from './pool-summary.mjs';

function rows() {
  return Array.from({ length: 10 }, (_, i) => ({
    bucket_at: `2026-11-16 12:${String(i).padStart(2, '0')}:00`,
    goroutines: 1, heap_alloc_bytes: 1, online_users: 1,
    db_open_conns: 3, db_in_use: 2, db_idle: 1, db_wait_count: 1000 + i * 2,
    ws_dispatch_total: 0, ws_rate_limit_drops_total: 0,
    http_requests: 0, http_5xx: 0, http_max_latency_ms: 0, http_avg_latency_ms: 0,
    diagnostics: { db_max_open: 4, db_wait_count_delta: 2, db_wait_duration_ms_delta: 6 },
  }));
}

test('sums recorded deltas rather than cumulative wait counters', () => {
  const result = summarizePoolTelemetry(rows());
  assert.equal(result.recordedWaitCountDeltaSum, 20);
  assert.equal(result.recordedWaitDurationMsDeltaSum, 60);
  assert.equal(result.meanRecordedWaitMs, 3);
  assert.equal(result.missingMinutes, 0);
  assert.equal(result.counterDecreases, 0);
  assert.equal(result.sampledPeakInUse, 2);
  assert.deepEqual(result.configuredMaxOpenValues, [4]);
});

test('exposes missing samples, counter decreases and changed/unlimited pool settings', () => {
  const input = rows();
  input[9].bucket_at = '2026-11-16 12:12:00';
  input[9].db_wait_count = 1;
  input[9].diagnostics.db_max_open = 0;
  const result = summarizePoolTelemetry(input);
  assert.equal(result.missingMinutes, 3);
  assert.equal(result.counterDecreases, 1);
  assert.deepEqual(result.configuredMaxOpenValues, [0, 4]);
});

test('no waits has no inferred mean and aggregate overflow is rejected', () => {
  const input = rows();
  for (const row of input) {
    row.diagnostics.db_wait_count_delta = 0;
    row.diagnostics.db_wait_duration_ms_delta = 0;
  }
  assert.equal(summarizePoolTelemetry(input).meanRecordedWaitMs, null);
  input[0].diagnostics.db_wait_duration_ms_delta = Number.MAX_SAFE_INTEGER;
  input[1].diagnostics.db_wait_duration_ms_delta = 1;
  assert.throws(() => summarizePoolTelemetry(input), /safe numeric range/);
});
