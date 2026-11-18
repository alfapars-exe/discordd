import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRuntimeTelemetry, normalizeRuntimeTelemetry } from './profile-telemetry.mjs';
import { runProfileWithReport } from './profile-lifecycle.mjs';

function buckets() {
  return Array.from({ length: 11 }, (_, minute) => ({
    bucket_at: `2026-11-16 12:${String(minute).padStart(2, '0')}:00`,
    goroutines: 51, heap_alloc_bytes: 7000000, online_users: 20,
    db_open_conns: 4, db_in_use: 1, db_idle: 3, db_wait_count: minute * 10,
    ws_dispatch_total: minute * 100, ws_rate_limit_drops_total: 0,
    http_requests: 100, http_5xx: 0, http_max_latency_ms: 20, http_avg_latency_ms: 2.5,
    diagnostics: { db_max_open: 4, db_wait_count_delta: 10, db_wait_duration_ms_delta: 20 },
  }));
}

test('negative control: reading after cleanup fails when the owned database is gone', async () => {
  let alive = true;
  await assert.rejects(runProfileWithReport({ report: {}, run() {}, cleanup() { alive = false; },
    writeReport() { if (!alive) throw new Error('owned database removed'); },
  }), /owned database removed/);
});

test('collection joins the read before cleanup and persists a sanitized result', async () => {
  const events = [], report = {};
  await runProfileWithReport({ report,
    run: () => collectRuntimeTelemetry({ report, read: async () => {
      events.push('read'); await Promise.resolve(); events.push('read-complete'); return buckets();
    } }),
    cleanup() { events.push('cleanup'); assert.equal(report.runtimeTelemetry.status, 'completed'); },
    writeReport() { events.push('report'); },
  });
  assert.deepEqual(events, ['read', 'read-complete', 'cleanup', 'report']);
  assert.equal(report.runtimeTelemetry.rows.length, 11);
  assert.equal(report.resultStatus, 'completed');
});

test('read failure records time and safe code, rejects success, and still cleans up', async () => {
  const report = {}; let cleaned = false;
  await assert.rejects(runProfileWithReport({ report,
    run: () => collectRuntimeTelemetry({ report, now: () => 'fixture-time', read() {
      throw Object.assign(new Error('private credential-bearing command'), { status: 1, code: 'ETIMEDOUT' });
    } }), cleanup() { cleaned = true; }, writeReport() {},
  }), /^Error: Runtime telemetry read failed$/);
  assert.equal(cleaned, true);
  assert.equal(report.resultStatus, 'failed');
  assert.deepEqual(report.failurePhases, ['workload']);
  assert.deepEqual(report.runtimeTelemetry, { status: 'failed', startedAt: 'fixture-time', finishedAt: 'fixture-time',
    failureCode: 'read_failed', childExitStatus: 1, systemCode: 'ETIMEDOUT' });
  assert.ok(!JSON.stringify(report).includes('private credential'));
});

test('invalid or incomplete data cannot become accepted measurement evidence', async () => {
  for (const rows of [[], buckets().slice(0, 9), [...buckets(), ...buckets()],
    buckets().map((row, i) => i ? row : { ...row, db_wait_count: -1 }),
    buckets().map((row, i) => i ? row : { ...row, bucket_at: '2026-02-30 12:00:00' })]) {
    const report = {};
    await assert.rejects(collectRuntimeTelemetry({ report, read: () => rows }), /Invalid runtime telemetry/);
    assert.equal(report.runtimeTelemetry.failureCode, 'invalid_data');
  }
});

test('private diagnostics and future columns are excluded by the output allowlist', () => {
  const rows = buckets();
  rows[0].private_token = 'must-not-publish';
  rows[0].diagnostics.app_log = { token: 'must-not-publish' };
  const selected = normalizeRuntimeTelemetry(rows);
  assert.ok(!JSON.stringify(selected).includes('must-not-publish'));
  assert.equal(selected[0].http_avg_latency_ms, 2.5);
});
