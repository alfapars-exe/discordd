/**
 * diagnosticBuffer — in-memory ring of recent diagnostic events for platforms
 * that have no local log file (web, Capacitor mobile).
 *
 * On Electron, every `logToServer` event is teed to a rotating ON-DISK file via
 * IPC (see electron/diagnostic-log.ts) so it survives offline / pre-login /
 * WS-down / crash. Browsers and mobile can't write arbitrary files, so we keep
 * the last N events in memory instead — enough for an "Export / upload
 * diagnostics" action to have recent context to hand over. Bounded; the oldest
 * entries fall off.
 *
 * Privacy: holds the same events + metadata as the server telemetry — no
 * message bodies / tokens / keys (callers redact at the logToServer boundary).
 */

export interface DiagnosticBufferEntry {
  ts: string;
  level: "info" | "warn" | "error";
  msg: string;
  meta?: Record<string, unknown>;
}

const MAX_ENTRIES = 2000;
const ring: DiagnosticBufferEntry[] = [];

/** Append one event, dropping the oldest once the ring is full. */
export function pushDiagnostic(entry: DiagnosticBufferEntry): void {
  ring.push(entry);
  if (ring.length > MAX_ENTRIES) {
    ring.splice(0, ring.length - MAX_ENTRIES);
  }
}

/** Snapshot copy of the current ring (newest last). */
export function snapshotDiagnostics(): DiagnosticBufferEntry[] {
  return ring.slice();
}

/** Ring serialized as newline-delimited JSON — same shape as the Electron file. */
export function serializeDiagnostics(): string {
  return ring.map((e) => JSON.stringify(e)).join("\n");
}

/** Current number of buffered events (for UI / diagnostics-about-diagnostics). */
export function diagnosticCount(): number {
  return ring.length;
}
