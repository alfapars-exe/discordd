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
 *     sendDefaultPii: false. beforeSendTransaction applies the same redaction
 *     to browserTracingIntegration's transaction events, which beforeSend
 *     never sees — see scrubTransactionEvent for which fields actually
 *     carry the query string (span.data, not span.description).
 */
import * as Sentry from "@sentry/react";
import type { Breadcrumb, ErrorEvent as SentryErrorEvent } from "@sentry/react";
import type { ErrorInfo } from "react";
import { isElectron, isCapacitor } from "../utils/constants";

// Mirrors server/pkg/redact.go's secretParams list exactly — the client
// must never let a DSN, token, or password reach Sentry's ingest endpoint
// via an error message or breadcrumb URL (e.g. a ws-ticket query param).
const SECRET_PARAMS = ["authtoken=", "password=", "apikey=", "api_key=", "secret=", "token=", "ticket="];

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
    // Guard against a future empty entry in SECRET_PARAMS: an empty key
    // matches at index 0 of every value.slice() call in redactParam and
    // never advances, looping forever and hanging the main thread inside
    // beforeSend/beforeBreadcrumb.
    if (key === "") continue;
    result = redactParam(result, key);
  }
  return result;
}

// Bound on redactStringValues' recursion depth — Sentry's own breadcrumb/
// span/context payloads are at most one or two levels deep, so this is a
// defensive cap against runaway or cyclic recursion, not a depth these
// hooks are expected to reach in practice.
const REDACT_MAX_DEPTH = 4;

/**
 * Recursively redacts secret query-params from every string value found in
 * an object or array, mutating it in place. Shared by scrubBreadcrumb,
 * scrubTransactionEvent, and scrubErrorEvent so a field none of them knows
 * about yet (a new breadcrumb.data key, a new span attribute, ...) is
 * redacted by default instead of leaking until someone adds an explicit
 * per-field check for it.
 */
function redactStringValues(value: unknown, depth: number = REDACT_MAX_DEPTH): void {
  if (depth <= 0 || value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      if (typeof item === "string") {
        value[i] = redactSecrets(item);
      } else {
        redactStringValues(item, depth - 1);
      }
    }
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (typeof item === "string") {
      record[key] = redactSecrets(item);
    } else {
      redactStringValues(item, depth - 1);
    }
  }
}

/**
 * ASCII case-insensitive indexOf that scans the ORIGINAL string instead of a
 * lower-cased copy. `String.prototype.toLowerCase()` is not length-preserving
 * for every code point (e.g. Turkish "İ", U+0130, expands to two code units:
 * "i" + U+0307). Folding the whole haystack before searching therefore shifts
 * the returned index whenever such a character appears before the match,
 * causing a downstream slice to leak part of the redacted value. Comparing a
 * same-length window instead of the whole string sidesteps that: `key` is a
 * short ASCII literal, so even if `window.toLowerCase()` changes length it
 * simply fails to equal `key` rather than reporting a shifted offset.
 * Port of indexFold in server/pkg/redact.go.
 */
function indexFold(s: string, key: string): number {
  for (let i = 0; i + key.length <= s.length; i++) {
    if (s.slice(i, i + key.length).toLowerCase() === key) {
      return i;
    }
  }
  return -1;
}

function redactParam(s: string, key: string): string {
  let out = "";
  let rest = s;

  for (;;) {
    const i = indexFold(rest, key);
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

// Exported only so sentry.test.ts can exercise the E2EE-safety invariant
// each hook enforces; initSentry() is the only production caller.
export function scrubErrorEvent(event: SentryErrorEvent): SentryErrorEvent {
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

/**
 * Redacts secret query-params from a transaction event's span descriptions,
 * span data, trace context data, request URL, and transaction name, and
 * drops request.headers. Without this, browserTracingIntegration
 * (tracesSampleRate 0.1) sends transaction events straight past beforeSend,
 * which only scrubs error events — a ticket/token in a traced request URL
 * would leak untouched.
 *
 * span.description alone is NOT where the query string lives:
 * @sentry/core's getSanitizedUrlString (used to build the span name/
 * description) strips the query entirely, but the query survives in
 * span.data (`url`, `http.url`, `http.query`) and in
 * event.contexts.trace.data — both are redacted here via
 * redactStringValues so any such field, present or future, is covered.
 *
 * request.headers is dropped for parity with scrubErrorEvent's
 * `event.request = undefined`: Referer/User-Agent headers can carry the
 * previous page's full URL (query string included, e.g. a password-reset
 * token), and sendDefaultPii: false alone doesn't stop
 * browserTracingIntegration from attaching them here.
 *
 * Typed generically over Sentry's exported Event type (TransactionEvent
 * itself isn't re-exported by @sentry/react) so the parameter/return type
 * stays exactly what Sentry.init's beforeSendTransaction expects.
 */
// Exported only so sentry.test.ts can exercise the E2EE-safety invariant
// each hook enforces; initSentry() is the only production caller.
export function scrubTransactionEvent<E extends Sentry.Event>(event: E): E {
  if (event.transaction) {
    event.transaction = redactSecrets(event.transaction);
  }
  if (event.request) {
    if (event.request.url) {
      event.request.url = redactSecrets(event.request.url);
    }
    delete event.request.headers;
  }
  if (event.spans) {
    for (const span of event.spans) {
      if (span.description) {
        span.description = redactSecrets(span.description);
      }
      if (span.data) {
        redactStringValues(span.data);
      }
    }
  }
  if (event.contexts?.trace?.data) {
    redactStringValues(event.contexts.trace.data);
  }
  return event;
}

// Exported only so sentry.test.ts can exercise the E2EE-safety invariant
// each hook enforces; initSentry() is the only production caller.
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  // Highest E2EE leak risk: crypto modules sometimes console.log key
  // material or plaintext while debugging a decrypt failure. Drop every
  // console breadcrumb rather than trying to redact arbitrary log text.
  if (breadcrumb.category === "console") {
    return null;
  }
  // Redact every string value in breadcrumb.data regardless of category —
  // not just fetch/xhr's `url`. A navigation breadcrumb's `data.from`/
  // `data.to` (the full relative URL, query string included — see
  // @sentry/core's parseUrl) leaked a plaintext password-reset token this
  // way; category-gating the redaction meant any category the SDK adds
  // data to next was unprotected by default.
  if (breadcrumb.data) {
    redactStringValues(breadcrumb.data);
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
    beforeSendTransaction: (event) => scrubTransactionEvent(event),
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
