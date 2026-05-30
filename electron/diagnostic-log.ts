/**
 * electron/diagnostic-log.ts — Always-on local rolling diagnostic log.
 *
 * Server telemetry (client/src/api/clientLog.ts → /client-log) is best-effort
 * and DROPS exactly when things break — offline, pre-login, WebSocket down, or
 * a process crash. This module persists the SAME structured events (plus
 * main-process and native-helper events the renderer never sees) to a rotating
 * local file that survives all of those, so the user can export/upload it for
 * support later. See client-side tee in clientLog.ts and the export path in
 * ipc-handlers.ts (`export-diagnostics` / feedback upload).
 *
 * PRIVACY — events + metadata ONLY. Callers MUST NOT pass message bodies,
 * passwords, tokens, or E2EE key material. Renderer entries are redacted at the
 * logToServer boundary; main-process callers follow the same rule. This file
 * only size-caps values, it does not deep-redact.
 *
 * Format — newline-delimited JSON (one event per line):
 *   {"ts":"<iso>","level":"info|warn|error","source":"main|renderer|native","category":"…","msg":"…","meta":{…}}
 *
 * Rotation — a size-capped ring under app.getPath("logs"):
 *   diagnostic.log (active) → diagnostic.1.log → diagnostic.2.log (oldest dropped)
 *
 * Durability — writes are buffered and flushed on a 1 s timer + on demand
 * (flushDiagnostics) + at exit. A crash loses at most ~1 s of the newest lines
 * and never blocks the caller. Crash-reporter calls flushDiagnostics()
 * synchronously right after recording a crash so that row is always on disk.
 */

import { app } from "electron";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";
import path from "path";

export type DiagnosticSource = "main" | "renderer" | "native";
export type DiagnosticLevel = "info" | "warn" | "error";

export interface DiagnosticEntry {
  ts?: string; // ISO 8601; filled in if absent
  level?: DiagnosticLevel;
  source?: DiagnosticSource;
  category?: string;
  msg: string;
  meta?: Record<string, unknown>;
}

// Per-file cap before rotation. 4 MB × 3 files ≈ 12 MB ceiling — large enough
// to hold a long session (events are ~100-300 B each → 10k-40k lines per file)
// while staying small enough to attach the newest file to a feedback upload.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ROTATIONS = 2; // diagnostic.1.log, diagnostic.2.log
const FLUSH_INTERVAL_MS = 1000;
const MAX_BUFFER_LINES = 400; // flush early if a burst fills the buffer
const MAX_MSG_LEN = 2000;
const MAX_META_VALUE_LEN = 4096;

let logsDir: string | null = null;
let buffer: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let verbose = false;
let initialized = false;

function dir(): string {
  if (!logsDir) logsDir = app.getPath("logs");
  return logsDir;
}
function activePath(): string {
  return path.join(dir(), "diagnostic.log");
}
function rolledPath(n: number): string {
  return path.join(dir(), `diagnostic.${n}.log`);
}

/** Coerce a meta object into JSON-safe, size-capped scalars/strings. */
function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      out[k] = v.length > MAX_META_VALUE_LEN ? v.slice(0, MAX_META_VALUE_LEN) : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      try {
        const s = JSON.stringify(v);
        out[k] = s.length > MAX_META_VALUE_LEN ? s.slice(0, MAX_META_VALUE_LEN) : s;
      } catch {
        out[k] = String(v).slice(0, MAX_META_VALUE_LEN);
      }
    }
  }
  return out;
}

/** active → diagnostic.1.log → diagnostic.2.log, dropping the oldest. */
function rotateIfNeeded(): void {
  try {
    const active = activePath();
    if (!existsSync(active) || statSync(active).size < MAX_FILE_BYTES) return;
    const oldest = rolledPath(ROTATIONS);
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let n = ROTATIONS - 1; n >= 1; n--) {
      const from = rolledPath(n);
      if (existsSync(from)) renameSync(from, rolledPath(n + 1));
    }
    renameSync(active, rolledPath(1));
  } catch {
    /* best effort — rotation failure must not break logging */
  }
}

function flush(): void {
  if (buffer.length === 0) return;
  const data = buffer.join("");
  buffer = [];
  try {
    mkdirSync(dir(), { recursive: true });
    appendFileSync(activePath(), data, "utf8");
    rotateIfNeeded();
  } catch {
    /* swallow — diagnostics must never break the app */
  }
}

/** Force any buffered lines to disk now. Safe to call from crash paths/exit. */
export function flushDiagnostics(): void {
  flush();
}

/**
 * Append one structured event. Never throws, never blocks. Lines are buffered
 * and flushed within ~1 s (or immediately once the buffer fills).
 */
export function appendDiagnostic(entry: DiagnosticEntry): void {
  try {
    const line =
      JSON.stringify({
        ts: entry.ts || new Date().toISOString(),
        level: entry.level || "info",
        source: entry.source || "main",
        category: entry.category || "",
        msg: String(entry.msg ?? "").slice(0, MAX_MSG_LEN),
        ...(entry.meta && Object.keys(entry.meta).length
          ? { meta: sanitizeMeta(entry.meta) }
          : {}),
      }) + "\n";
    buffer.push(line);
    if (buffer.length >= MAX_BUFFER_LINES) flush();
  } catch {
    /* swallow */
  }
}

/** Shorthand for a main-process event. Mirrors warn/error to the console. */
export function mainLog(
  level: DiagnosticLevel,
  message: string,
  meta?: Record<string, unknown>,
): void {
  appendDiagnostic({ level, source: "main", msg: message, meta });
  if (level === "error") console.error(`[diag] ${message}`, meta ?? "");
  else if (level === "warn") console.warn(`[diag] ${message}`, meta ?? "");
}

/**
 * Verbose-only event — dropped unless verbose mode is on. Use for high-volume
 * or low-signal breadcrumbs that only matter during an active repro session.
 */
export function debugLog(
  source: DiagnosticSource,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (!verbose) return;
  appendDiagnostic({ level: "info", source, category: "debug", msg: message, meta });
}

export function setVerbose(on: boolean): void {
  verbose = on;
}
export function isVerbose(): boolean {
  return verbose;
}

export function getLogsDir(): string {
  return dir();
}

/** Existing diagnostic log files, newest first — for the export bundle. */
export function getDiagnosticLogPaths(): string[] {
  const candidates = [activePath()];
  for (let n = 1; n <= ROTATIONS; n++) candidates.push(rolledPath(n));
  return candidates.filter((p) => existsSync(p));
}

/**
 * Initialize the rolling log: ensure the dir exists, start the flush timer, and
 * write a session-start marker with the runtime fingerprint every later row can
 * be correlated against. Call once, early in main.ts (before the window).
 */
export function initDiagnosticLog(): void {
  if (initialized) return;
  initialized = true;
  try {
    mkdirSync(dir(), { recursive: true });
  } catch {
    /* getPath('logs') should always be writable; ignore */
  }

  appendDiagnostic({
    level: "info",
    source: "main",
    category: "lifecycle",
    msg: "session_start",
    meta: {
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      packaged: app.isPackaged,
    },
  });
  flush();

  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive solely for the flush timer.
  flushTimer.unref?.();

  // Best-effort final flush on the way out.
  app.on("before-quit", () => {
    appendDiagnostic({ level: "info", source: "main", category: "lifecycle", msg: "session_end" });
    flush();
  });
}
