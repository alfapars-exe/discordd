/**
 * globalErrorLogger — registers window-level diagnostic listeners once.
 *
 * Captures four classes of event that no other module is positioned to see:
 *   - Uncaught synchronous exceptions  (window.onerror)
 *   - Unhandled promise rejections     (window.onunhandledrejection)
 *   - Network restored                 (window.online)
 *   - Network lost                     (window.offline)
 *
 * Idempotent: a module-level boolean guards against double-install under
 * React StrictMode / Vite HMR. Safe to call from main.tsx.
 *
 * Online/offline notes: clientLog.ts caches its common metadata (including
 * navigator.connection) on first emit, so subsequent network_online events
 * would otherwise carry the stale "session-start" connection snapshot.
 * We re-derive the connection fields inline at event time and pass them
 * as event metadata — clientLog's spread order ensures event metadata
 * overrides the cached common fields.
 */

import { logToServer } from "./clientLog";

let installed = false;

const MAX_MESSAGE_LEN = 200;
const MAX_STACK_LEN = 1024;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Reads navigator.connection live (not from clientLog's cache) so online/offline
 * events report the connection state at the moment of the event, not at the
 * moment the cache was first populated.
 */
function readLiveConnectionInfo(): Record<string, string> {
  if (typeof navigator === "undefined") return {};
  type NavWithConnection = Navigator & {
    connection?: {
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
      type?: string;
    };
  };
  const c = (navigator as NavWithConnection).connection;
  if (!c) return {};
  const out: Record<string, string> = {};
  if (c.effectiveType) out.connEffectiveType = c.effectiveType;
  if (typeof c.downlink === "number") out.connDownlink = String(c.downlink);
  if (typeof c.rtt === "number") out.connRtt = String(c.rtt);
  if (c.type) out.connType = c.type;
  return out;
}

export function installGlobalErrorLogger(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    const err = event.error;
    logToServer("error", "client_uncaught_error", {
      message: truncate(event.message || "", MAX_MESSAGE_LEN),
      filename: event.filename || "",
      lineno: event.lineno,
      colno: event.colno,
      stack: err instanceof Error && err.stack ? truncate(err.stack, MAX_STACK_LEN) : "",
      errorName: err instanceof Error ? err.name : typeof err,
    });
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const isError = reason instanceof Error;
    logToServer("error", "client_unhandled_rejection", {
      reason: truncate(isError ? reason.message : String(reason), MAX_MESSAGE_LEN),
      stack: isError && reason.stack ? truncate(reason.stack, MAX_STACK_LEN) : "",
      errorName: isError ? reason.name : typeof reason,
    });
  });

  window.addEventListener("online", () => {
    logToServer("info", "network_online", readLiveConnectionInfo());
  });

  window.addEventListener("offline", () => {
    logToServer("warn", "network_offline", readLiveConnectionInfo());
  });
}
