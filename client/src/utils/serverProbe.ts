/**
 * serverProbe — lightweight liveness check for the backend.
 *
 * Used by useServerWakeUp to detect when an HF Space has finished cold-starting
 * after returning 503. We deliberately bypass apiClient (no auth header, no
 * refresh flow, no cookie credentials) because:
 *   1. The probe should be the cheapest possible call — just a GET on /health.
 *   2. We don't want a 401 → refresh loop to fire while the server is still
 *      booting; refresh would also 503 and could pollute auth state.
 *   3. The probe runs many times per wake-up cycle; carrying a stale access
 *      token around would attract token-leak audits for no benefit.
 *
 * Returns true only on a clean 2xx response. Anything else (4xx, 5xx, network
 * error, timeout) is treated as "server still not ready."
 */

import { API_BASE_URL } from "./constants";

const PROBE_TIMEOUT_MS = 5_000;

export async function pingServer(): Promise<boolean> {
  // AbortController gives us a hard ceiling — without it a stuck TCP handshake
  // could pin the probe for the browser's default ~90s, making the retry loop
  // effectively useless.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE_URL}/health`, {
      method: "GET",
      // Same-origin in web mode, absolute in native — API_BASE_URL handles both.
      // No credentials: probe shouldn't carry the HttpOnly refresh cookie.
      credentials: "omit",
      signal: controller.signal,
      // Hint to caches/proxies: this is a liveness check, don't serve stale.
      cache: "no-store",
    });
    return res.ok;
  } catch {
    // Abort, DNS, connection refused — all mean "not ready yet."
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
