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
 *
 * User-facing notification: uncaught exceptions and unhandled rejections
 * are real, unexpected bugs (as opposed to API failures, which apiClient
 * returns as a Result and never throws — those are surfaced per-call-site
 * via src/utils/apiError.ts's showApiError). We show one deduped "something
 * went wrong" toast per short window rather than a toast per event, since a
 * single failure often cascades into several error/rejection events.
 * online/offline stay log-only here — ConnectionBanner already owns the
 * user-facing surface for connectivity state.
 */

import { logToServer } from "./clientLog";
import { useToastStore } from "../stores/toastStore";
import i18n from "../i18n";

let installed = false;

/** Minimum gap between consecutive "unexpected error" toasts. */
const NOTIFY_DEDUP_WINDOW_MS = 10_000;
let lastNotifiedAt = 0;

/** Shows the generic unexpected-error toast, deduped within the window above. */
function notifyUnexpectedError(): void {
  const now = Date.now();
  if (now - lastNotifiedAt < NOTIFY_DEDUP_WINDOW_MS) return;
  lastNotifiedAt = now;
  useToastStore.getState().addToast("error", i18n.t("errors:unknown"), undefined, {
    title: i18n.t("errors:unknownTitle"),
  });
}

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
    notifyUnexpectedError();
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const isError = reason instanceof Error;
    logToServer("error", "client_unhandled_rejection", {
      reason: truncate(isError ? reason.message : String(reason), MAX_MESSAGE_LEN),
      stack: isError && reason.stack ? truncate(reason.stack, MAX_STACK_LEN) : "",
      errorName: isError ? reason.name : typeof reason,
    });
    notifyUnexpectedError();
  });

  window.addEventListener("online", () => {
    logToServer("info", "network_online", readLiveConnectionInfo());
  });

  window.addEventListener("offline", () => {
    logToServer("warn", "network_offline", readLiveConnectionInfo());
  });
}
