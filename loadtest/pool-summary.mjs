import { normalizeRuntimeTelemetry } from './profile-telemetry.mjs';

/** Describe persisted samples, never infer query latency or a pool budget. */
export function summarizePoolTelemetry(input) {
  const rows = normalizeRuntimeTelemetry(input);
  let waits = 0;
  let durationMs = 0;
  let missingMinutes = 0;
  let counterDecreases = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    waits += row.diagnostics.db_wait_count_delta;
    durationMs += row.diagnostics.db_wait_duration_ms_delta;
    if (!Number.isSafeInteger(waits) || !Number.isSafeInteger(durationMs)) {
      throw new RangeError('Pool summary exceeds safe numeric range');
    }
    if (i > 0) {
      const previous = rows[i - 1];
      const instant = value => Date.parse(value.replace(' ', 'T') + 'Z');
      missingMinutes += (instant(row.bucket_at) - instant(previous.bucket_at)) / 60000 - 1;
      if (row.db_wait_count < previous.db_wait_count) counterDecreases++;
    }
  }
  return {
    buckets: rows.length,
    firstBucket: rows[0].bucket_at,
    lastBucket: rows.at(-1).bucket_at,
    missingMinutes,
    counterDecreases,
    recordedWaitCountDeltaSum: waits,
    recordedWaitDurationMsDeltaSum: durationMs,
    meanRecordedWaitMs: waits === 0 ? null : durationMs / waits,
    sampledPeakOpen: Math.max(...rows.map(row => row.db_open_conns)),
    sampledPeakInUse: Math.max(...rows.map(row => row.db_in_use)),
    configuredMaxOpenValues: [...new Set(rows.map(row => row.diagnostics.db_max_open))].sort((a, b) => a - b),
    scope: 'Recorded interval deltas and instantaneous pool samples only. Duration deltas are truncated to milliseconds by the server. No query count, latency percentile, full-run coverage, capacity or budget verdict; zero max-open means unlimited.',
  };
}
