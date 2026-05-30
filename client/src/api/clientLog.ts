/**
 * clientLog — best-effort diagnostic telemetry to the server.
 *
 * Emits structured log lines that land in `app_logs` with category=client.
 * Used to track screen-share lifecycle, Electron crash dumps, and native
 * helper failures — places where the server can't observe the client.
 *
 * Best-effort: failures are swallowed. A logging call must never throw,
 * never block the caller, and never raise an unhandled promise rejection.
 * If the network is down or the user isn't logged in yet, the call drops.
 *
 * Common metadata (platform / userAgent / cpu / memory / screen) is attached
 * automatically — callers only pass event-specific fields. Common fields are
 * captured once on first call and reused; cheap to compute but pointless to
 * re-derive on every emit.
 */

import { apiClient } from "./client";
import { isElectron, isCapacitor } from "../utils/constants";
import { pushDiagnostic } from "./diagnosticBuffer";

type LogLevel = "info" | "warn" | "error";

type MetadataValue = string | number | boolean | null | undefined;

type Metadata = Record<string, MetadataValue>;

/**
 * Common env fields lazy-cached on first use. These don't change during a
 * session, so recomputing them per log call would waste cycles.
 */
let commonMetadataCache: Record<string, string> | null = null;

/**
 * Capture once: things that need an async call (Electron getVersion).
 * Stored as Promise so concurrent first-callers share the work.
 */
let electronVersionPromise: Promise<string | null> | null = null;

function getElectronVersion(): Promise<string | null> {
  if (!isElectron() || !window.electronAPI?.getVersion) {
    return Promise.resolve(null);
  }
  if (!electronVersionPromise) {
    electronVersionPromise = window.electronAPI
      .getVersion()
      .catch(() => null);
  }
  return electronVersionPromise;
}

function getPlatform(): string {
  if (isElectron()) {
    // The userAgent in Electron contains "Electron/X.Y.Z" — sufficient for
    // breakdown by Electron version. OS family is inferred server-side from
    // the same string (we don't want to require an extra IPC just for this).
    if (typeof navigator !== "undefined") {
      if (/Windows/.test(navigator.userAgent)) return "electron-win";
      if (/Mac OS X|Macintosh/.test(navigator.userAgent)) return "electron-mac";
      if (/Linux/.test(navigator.userAgent)) return "electron-linux";
    }
    return "electron";
  }
  if (isCapacitor()) return "capacitor";
  return "browser";
}

function getConnectionInfo(): Record<string, string> {
  if (typeof navigator === "undefined") return {};
  // `connection` is on most Chromium-based UAs (Electron always, Chrome,
  // Edge, Android Chrome). Safari + Firefox don't expose it — skip silently.
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

function getScreenInfo(): Record<string, string> {
  if (typeof window === "undefined" || !window.screen) return {};
  return {
    screenWidth: String(window.screen.width),
    screenHeight: String(window.screen.height),
    screenColorDepth: String(window.screen.colorDepth),
    devicePixelRatio: String(window.devicePixelRatio || 1),
  };
}

function getDeviceInfo(): Record<string, string> {
  if (typeof navigator === "undefined") return {};
  const out: Record<string, string> = {
    userAgent: navigator.userAgent.slice(0, 512),
    platform: getPlatform(),
    language: navigator.language || "",
  };
  if (typeof navigator.hardwareConcurrency === "number") {
    out.cpuCores = String(navigator.hardwareConcurrency);
  }
  // `deviceMemory` is Chromium-only and reports GB rounded to the nearest
  // power of two — useful for the "weak hardware" hypothesis even with that
  // coarse resolution.
  type NavWithMemory = Navigator & { deviceMemory?: number };
  const mem = (navigator as NavWithMemory).deviceMemory;
  if (typeof mem === "number") out.deviceMemoryGB = String(mem);
  return out;
}

async function buildCommonMetadata(): Promise<Record<string, string>> {
  if (commonMetadataCache) return commonMetadataCache;

  const electronVersion = await getElectronVersion();
  const base: Record<string, string> = {
    ...getDeviceInfo(),
    ...getScreenInfo(),
    ...getConnectionInfo(),
  };
  // Prefer Electron's runtime app.getVersion() (authoritative for desktop
  // builds) and fall back to the Vite-injected __APP_VERSION__ for the
  // web bundle — without the fallback, browser-only users had no version
  // tag in their logs and we couldn't tell "stuck on a cached old bundle"
  // from "running latest".
  if (electronVersion) {
    base.appVersion = electronVersion;
  } else if (typeof __APP_VERSION__ === "string" && __APP_VERSION__) {
    base.appVersion = __APP_VERSION__;
  }

  commonMetadataCache = base;
  return base;
}

/**
 * Send a log line to the server. Returns a resolved promise even on failure
 * — callers should not await for correctness, only to chain follow-up work.
 *
 * Metadata values are coerced to strings (matches the server-side map[string]string
 * shape). null / undefined are dropped so they don't show as "null" in the
 * admin panel.
 */
export async function logToServer(
  level: LogLevel,
  message: string,
  metadata: Metadata = {},
): Promise<void> {
  // Local tee FIRST — persist to the always-on diagnostic log before the
  // best-effort server send, so the event survives offline / pre-login /
  // WS-down / crash (exactly when the server send drops). Electron → rotating
  // file via IPC; web/Capacitor → in-memory ring. Event-specific metadata only;
  // the env fingerprint lives in the diagnostic log's session_start row.
  try {
    if (isElectron() && window.electronAPI?.appendDiagnostic) {
      window.electronAPI.appendDiagnostic({ level, msg: message, meta: metadata });
    } else {
      pushDiagnostic({ ts: new Date().toISOString(), level, msg: message, meta: metadata });
    }
  } catch {
    /* swallow — local tee must never break the caller */
  }

  try {
    const common = await buildCommonMetadata();
    const serialized: Record<string, string> = { ...common };
    for (const [k, v] of Object.entries(metadata)) {
      if (v === null || v === undefined) continue;
      serialized[k] = typeof v === "string" ? v : String(v);
    }

    // Mirror to console for local dev — admin panel is the production path.
    if (level === "error") {
      console.error(`[clientLog] ${message}`, serialized);
    } else if (level === "warn") {
      console.warn(`[clientLog] ${message}`, serialized);
    }

    // Fire and forget. apiClient already handles auth (and silently fails
    // when no token is set, which is exactly what we want pre-login).
    await apiClient("/client-log", {
      method: "POST",
      body: { level, message, metadata: serialized },
    });
  } catch {
    /* swallow — diagnostic logging must never break the caller */
  }
}
