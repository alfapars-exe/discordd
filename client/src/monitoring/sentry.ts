/**
 * Sentry error + performance monitoring — DSN-gated, E2EE-safe.
 *
 * Mirrors server/pkg/logx/sentry.go: no DSN configured means Sentry.init is
 * never called, so local dev / self-hosted builds without a DSN stay a
 * complete no-op (no network calls, no global hub installed).
 *
 * E2EE safety (why the scrub hooks below exist):
 *   - This is an end-to-end encrypted chat app. Crypto code paths sometimes
 *     console.log plaintext or key material while debugging a decrypt
 *     failure. Sentry's default console breadcrumb integration would
 *     capture that. beforeBreadcrumb drops every console breadcrumb.
 *   - Session Replay is NEVER enabled here (no replayIntegration) — replay
 *     would record the DOM, i.e. decrypted message text, which is the
 *     exact content E2EE exists to protect.
 *   - beforeSend redacts the same secret query-params the server redacts
 *     (server/pkg/redact.go) from the event message and exception values,
 *     and strips event.request as a second guard on top of
 *     sendDefaultPii: false.
 */
import * as Sentry from "@sentry/react";
import type { Breadcrumb, ErrorEvent as SentryErrorEvent } from "@sentry/react";
import type { ErrorInfo } from "react";
import { isElectron, isCapacitor } from "../utils/constants";

// Mirrors server/pkg/redact.go's secretParams list exactly — the client
// must never let a DSN, token, or password reach Sentry's ingest endpoint
// via an error message or breadcrumb URL (e.g. a ws-ticket query param).
const SECRET_PARAMS = ["authtoken=", "password=", "apikey=", "api_key=", "secret=", "token="];

// Mirrors server/pkg/redact.go's valueTerminators.
const VALUE_TERMINATORS = /[&"' \t\r\n]/;

/**
 * Redacts `key=value` secret query-params from a string, case-insensitively,
 * preserving the original key casing. Port of redactParam/redactSecrets in
 * server/pkg/redact.go — keep the two in sync if either list changes.
 */
export function redactSecrets(s: string): string {
  let result = s;
  for (const key of SECRET_PARAMS) {
    result = redactParam(result, key);
  }
  return result;
}

function redactParam(s: string, key: string): string {
  let out = "";
  let rest = s;

  for (;;) {
    const i = rest.toLowerCase().indexOf(key);
    if (i < 0) {
      out += rest;
      return out;
    }

    out += rest.slice(0, i);
    out += rest.slice(i, i + key.length); // original casing
    out += "***";

    const value = rest.slice(i + key.length);
    const match = VALUE_TERMINATORS.exec(value);
    if (!match) {
      return out;
    }
    rest = value.slice(match.index);
  }
}

/** web / electron / capacitor — same three-way split clientLog.ts uses. */
function detectPlatform(): string {
  if (isElectron()) return "electron";
  if (isCapacitor()) return "capacitor";
  return "web";
}

function scrubErrorEvent(event: SentryErrorEvent): SentryErrorEvent {
  if (event.message) {
    event.message = redactSecrets(event.message);
  }
  if (event.exception?.values) {
    for (const value of event.exception.values) {
      if (value.value) {
        value.value = redactSecrets(value.value);
      }
    }
  }
  // Belt-and-suspenders on top of sendDefaultPii: false — never let a
  // captured request object (headers, cookies) leave the browser.
  event.request = undefined;
  return event;
}

function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  // Highest E2EE leak risk: crypto modules sometimes console.log key
  // material or plaintext while debugging a decrypt failure. Drop every
  // console breadcrumb rather than trying to redact arbitrary log text.
  if (breadcrumb.category === "console") {
    return null;
  }
  if (
    (breadcrumb.category === "fetch" || breadcrumb.category === "xhr") &&
    typeof breadcrumb.data?.url === "string"
  ) {
    breadcrumb.data.url = redactSecrets(breadcrumb.data.url);
  }
  return breadcrumb;
}

/**
 * Initializes Sentry when VITE_SENTRY_DSN is configured. No-op (Sentry.init
 * is never called) when the DSN is absent, matching the server's DSN-gate
 * pattern so a DSN-less build (local dev, self-host) never phones home.
 */
export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;

  const environment = (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) || import.meta.env.MODE;

  Sentry.init({
    dsn,
    release: __APP_VERSION__,
    environment,
    sendDefaultPii: false,
    sampleRate: 1.0,
    // Kept low — the Sentry project quota is shared with the server, which
    // already reports every 5xx/panic uncapped. See PROJECT_MEMORY.
    tracesSampleRate: 0.1,
    // Same-origin only: HF Space's edge doesn't send
    // Access-Control-Allow-Credentials on cross-origin preflights, so a
    // sentry-trace/baggage header on a cross-origin request would trip
    // the same CORS failure Electron/Capacitor already hit once.
    tracePropagationTargets: [/^\//],
    integrations: [Sentry.browserTracingIntegration()],
    beforeSend: (event) => scrubErrorEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });

  Sentry.setTag("platform", detectPlatform());
}

/** Reports a React error-boundary catch to Sentry with the component stack. */
export function captureBoundaryError(error: Error, errorInfo: ErrorInfo): void {
  Sentry.captureException(error, {
    contexts: { react: { componentStack: errorInfo.componentStack } },
  });
}
