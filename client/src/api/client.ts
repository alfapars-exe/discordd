/**
 * HTTP API client — all backend requests go through this module.
 *
 * Handles auth token injection, 401 refresh flow, and consistent error handling.
 *
 * Token storage model (post C2):
 *   - Access token:  in-memory only (module variable below). Short-lived,
 *     re-issued on every refresh. XSS that exfiltrates this gets at most a
 *     few minutes of access.
 *   - Refresh token: HttpOnly cookie set by the server. The browser sends
 *     it automatically on /api/auth/refresh requests (via
 *     `credentials: 'include'`), but JavaScript cannot read it — so even a
 *     stored XSS in any rendered field cannot lift the long-lived
 *     credential. localStorage is no longer used for refresh tokens.
 *     Its SameSite attribute is Strict for web and None for the native
 *     shells (which are cross-site with the API and would otherwise have
 *     the cookie rejected outright) — see clientHint() below.
 *
 * A `legacyMigrate` pass on first load drains any pre-C2 refresh token from
 * localStorage and clears it — the server will set the HttpOnly cookie on
 * the next refresh response, so the migration is transparent to the user.
 */

import type { APIResponse } from "../types";
import {
  API_BASE_URL,
  SERVER_URL,
  isAppProtocolPage,
  isCapacitor,
  isElectron,
} from "../utils/constants";

/**
 * Identifies the shell this build is running in, sent as X-HiChat-Client on
 * EVERY request (including the refresh call).
 *
 * The server uses it for two things:
 *
 *  1. Choosing the refresh cookie's SameSite attribute. Native shells run at
 *     a custom-scheme origin (app://hichat for Electron, capacitor:// for
 *     mobile) while the API lives on a different host, so their requests are
 *     cross-site — and Chromium REJECTS a SameSite=Strict cookie at set time
 *     on a cross-site response. Native clients therefore need SameSite=None
 *     or the refresh cookie is silently never stored, which is exactly why
 *     desktop registrations appeared to "not persist": login succeeded, but
 *     the next launch had no cookie to refresh with.
 *
 *  2. Gating the cookie path against CSRF. The server only reads the refresh
 *     cookie when this header is present, because a cross-site attacker
 *     cannot attach a custom header to a simple request without triggering a
 *     preflight that our origin allowlist rejects.
 *
 * Because of (2) the WEB build must send it too — "web" is a real value, not
 * a no-op. Omitting it would lock the browser client out of the cookie path.
 */
function clientHint(): "electron" | "capacitor" | "web" {
  // Electron wins if both somehow report true: an Electron build that also
  // pulls in the Capacitor shim is still an Electron shell.
  if (isElectron()) return "electron";
  if (isCapacitor()) return "capacitor";
  return "web";
}

/** Header name — must match handlers.clientHintHeader and the CORS allowlist. */
const CLIENT_HINT_HEADER = "X-HiChat-Client";

/**
 * Same-origin API proxy for the packaged Electron shell.
 *
 * The production backend sits behind Hugging Face's edge proxy, which
 * answers every CORS preflight (OPTIONS) itself — our server never sees
 * them — and its synthesized response omits
 * Access-Control-Allow-Credentials. Chromium rejects any credentialed
 * preflighted request on that omission, and from app://hichat every API
 * call is both credentialed (refresh cookie) and preflighted (this JSON +
 * custom-header traffic). Result: the desktop app could not even log in
 * ("Ağ hatası").
 *
 * Fix: when the page actually runs at app://hichat, talk to our OWN origin
 * (app://hichat/api/...) — same-origin means no preflight exists at all —
 * and let electron/api-proxy.ts relay the request to the real server from
 * the main process, where CORS doesn't apply. The real server origin rides
 * in X-HiChat-Upstream so the server picker stays the single source of
 * truth. Web, Capacitor, and the Vite-dev Electron shell (page origin
 * http://localhost:3030) keep talking to the server directly.
 */
const UPSTREAM_HEADER = "X-HiChat-Upstream";
const PROXY_API_BASE = "app://hichat/api";

// Not named use* — the React hooks lint rule treats any use-prefixed
// function as a hook and rejects calls from plain helpers.
function viaSameOriginProxy(): boolean {
  return isElectron() && isAppProtocolPage();
}

/** Builds the fetch URL for an API endpoint, routing via the proxy when packaged. */
function apiUrl(endpoint: string): string {
  return viaSameOriginProxy()
    ? `${PROXY_API_BASE}${endpoint}`
    : `${API_BASE_URL}${endpoint}`;
}

/** Adds the proxy routing header when (and only when) the proxy is in use. */
function withUpstreamHeader(headers: Record<string, string>): Record<string, string> {
  if (viaSameOriginProxy()) {
    headers[UPSTREAM_HEADER] = SERVER_URL;
  }
  return headers;
}

// Access token lives in module memory only — no localStorage read/write.
//
// Earlier revisions hydrated the access token from localStorage and
// mirrored every fresh issuance back to it so reloads stayed signed in.
// That re-exposed the short-lived credential to any XSS that could call
// localStorage.getItem, defeating the cookie-only refresh design. The
// current behaviour: on page reload, accessTokenMemory starts null, the
// first /api/users/me call returns 401, apiClient transparently calls
// /api/auth/refresh (using the HttpOnly refresh cookie), gets a fresh
// access token, retries the original request. Net UX cost: one extra
// round-trip on cold reload; net security gain: access token is never
// visible to scripts that can't intercept the in-memory variable
// directly (which is a much higher bar than reading a known storage key).
let accessTokenMemory: string | null = null;

// Sweep any leftovers from prior storage schemes so a stored XSS that
// scans localStorage can't lift a stale credential we no longer write.
try {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
} catch {
  /* private mode / quota — irrelevant, we don't store anything anyway */
}

function getAccessToken(): string | null {
  return accessTokenMemory;
}

function setTokens(access: string, _refresh: string): void {
  // Access token stays in memory only — see the comment at the top of
  // this file for the rationale. The _refresh parameter is unused; it
  // remains in the signature so the rest of the auth code can keep
  // calling setTokens(access, refresh) until we tidy the callers in a
  // follow-up. The server stopped including refresh_token in the JSON
  // body (AuthTokens.RefreshToken is `json:"-"` now), so most callers
  // already pass an empty string.
  accessTokenMemory = access;
}

function clearTokens(): void {
  accessTokenMemory = null;
  // Sweep historical entries — if a user was signed in under the old
  // localStorage scheme we still want logout to evict whatever they
  // had cached. New code never writes these keys.
  try {
    localStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
  } catch {
    /* ignore */
  }
}

/**
 * Refreshes an expired access token using the refresh token.
 *
 * Uses a shared promise lock to prevent multiple concurrent refresh requests.
 * Without this, parallel 401s would each try to refresh, invalidating each other's
 * tokens and causing unexpected logouts.
 */
let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = doRefresh();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function doRefresh(): Promise<boolean> {
  // The refresh token is delivered automatically via the HttpOnly cookie
  // because we pass `credentials: 'include'`. We send an empty body so the
  // server-side handler reads the cookie (legacy clients can still pass
  // refresh_token in the body if they don't manage cookies).
  try {
    const res = await fetch(apiUrl("/auth/refresh"), {
      method: "POST",
      headers: withUpstreamHeader({
        "Content-Type": "application/json",
        // Required, not decorative: the server ignores the refresh cookie
        // entirely on requests without this header (CSRF gate). Dropping it
        // here would break session restore on every platform.
        [CLIENT_HINT_HEADER]: clientHint(),
      }),
      credentials: "include",
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      // Only clear tokens on explicit auth rejection — 5xx/429/network errors
      // don't mean the token is invalid, just that the server/network failed.
      if (res.status === 401 || res.status === 403) {
        // Production builds intentionally suppress this warning; an attacker
        // with DevTools should not learn that the server rejected our
        // refresh attempt (one less oracle signal). Local dev still logs.
        if (import.meta.env?.DEV) {
          console.warn(`[apiClient] refresh endpoint returned ${res.status} — clearing tokens`);
        }
        clearTokens();
      }
      return false;
    }

    const data: APIResponse<{ access_token: string; refresh_token: string }> =
      await res.json();

    if (data.success && data.data) {
      // The server has already rotated the cookie via Set-Cookie. We still
      // pass the body's refresh_token to setTokens for callsite stability;
      // setTokens deliberately drops it on the floor.
      setTokens(data.data.access_token, data.data.refresh_token);
      return true;
    }

    return false;
  } catch {
    // Network error (timeout, DNS, offline) — tokens may still be valid, don't clear.
    return false;
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Abort the request after this many ms and resolve with `isTimeout: true`.
   * Opt-in per call site — there is deliberately NO global default: large
   * multipart uploads and slow-but-progressing GETs must not be cut off.
   * Used by the chat send path so a stalled connection can't freeze the
   * composer indefinitely.
   */
  timeoutMs?: number;
};

/**
 * Core HTTP request function. Generic type <T> specifies the expected response data type.
 *
 * Usage:
 *   const data = await apiClient<User[]>("/users");
 *   const user = await apiClient<User>("/users/me", { method: "PATCH", body: { display_name: "New" } });
 */
/**
 * Runs fetch with an optional timeout. A FRESH AbortController per physical
 * fetch: the 401-refresh retry re-fetches with the same RequestInit, and a
 * shared already-aborted signal would make that retry fail instantly.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs?: number
): Promise<Response> {
  if (!timeoutMs) return fetch(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Envelope for a request cut off by RequestOptions.timeoutMs. */
function timeoutResponse<T>(): APIResponse<T> {
  // No isNetworkError: retry helpers must not auto-retry a send that may
  // have been persisted server-side (duplicate risk, no idempotency key).
  return { success: false, error: "timeout", isTimeout: true } as APIResponse<T>;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export async function apiClient<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<APIResponse<T>> {
  const { method = "GET", body, headers: extraHeaders, timeoutMs } = options;

  const headers: Record<string, string> = withUpstreamHeader({
    ...extraHeaders,
    // Set after the spread so a caller-supplied header can never drop or
    // spoof the client hint — the server's cookie handling depends on it.
    [CLIENT_HINT_HEADER]: clientHint(),
  });

  // Proactive refresh — if the access token is inside the 5-minute pre-
  // expiry window, refresh BEFORE issuing the request rather than waiting
  // for the 401-retry cycle. The refresh promise lock in
  // refreshAccessToken() collapses parallel requests onto a single network
  // call. If refresh fails we still send with the stale token; the 401
  // handler below will try once more and then propagate the failure.
  let token = getAccessToken();
  if (token && isTokenAboutToExpire(token)) {
    await refreshAccessToken();
    token = getAccessToken();
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const fetchOptions: RequestInit = {
    method,
    headers,
    // Cookies (HttpOnly refresh token) ride along automatically. Server
    // CORS already restricts allowed origins so this isn't a CSRF vector.
    credentials: "include",
  };

  if (body) {
    fetchOptions.body =
      body instanceof FormData ? body : JSON.stringify(body);
  }

  let res: Response;

  try {
    res = await fetchWithTimeout(apiUrl(endpoint), fetchOptions, timeoutMs);
  } catch (err) {
    if (isAbortError(err)) {
      console.error(`[apiClient] ${method} ${endpoint}: timed out after ${timeoutMs}ms`);
      return timeoutResponse<T>();
    }
    const message =
      err instanceof Error ? err.message : "Network request failed";
    console.error(`[apiClient] ${method} ${endpoint}:`, message);
    // isNetworkError lets sendWithRetryAndToast decide "worth retrying"
    // vs "give up" without string-matching the error message.
    return { success: false, error: message, isNetworkError: true } as APIResponse<T>;
  }

  // 401 — attempt token refresh.
  //
  // Detailed status logging is dev-only. In production the same trace
  // would help an attacker correlate "refresh failed" with "retry"
  // timing; the only useful signal for end-users is the eventual error,
  // which is already returned to the caller below.
  const isDev = import.meta.env?.DEV;
  if (res.status === 401) {
    // Refresh token cookie is HttpOnly post-C2 — JS can't read it. We
    // just attempt refresh; the server-side cookie presence is what
    // matters. The old `getRefreshToken()` gate guarded against a
    // pre-cookie storage scheme that no longer exists.
    if (isDev) {
      console.warn(`[apiClient] 401 on ${method} ${endpoint} — attempting refresh`);
    }
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers["Authorization"] = `Bearer ${getAccessToken()}`;
      try {
        res = await fetchWithTimeout(
          apiUrl(endpoint),
          { ...fetchOptions, headers },
          timeoutMs
        );
        if (isDev) {
          console.warn(`[apiClient] retry after refresh: ${method} ${endpoint} status=${res.status}`);
        }
      } catch (err) {
        if (isAbortError(err)) {
          if (isDev) {
            console.error(`[apiClient] ${method} ${endpoint} (retry): timed out after ${timeoutMs}ms`);
          }
          return timeoutResponse<T>();
        }
        const message =
          err instanceof Error ? err.message : "Network request failed";
        if (isDev) {
          console.error(`[apiClient] ${method} ${endpoint} (retry):`, message);
        }
        return { success: false, error: message, isNetworkError: true } as APIResponse<T>;
      }
    } else if (isDev) {
      console.warn(`[apiClient] refresh FAILED on ${method} ${endpoint} — returning original 401`);
    }
  }

  // 204 No Content — no body to parse
  if (res.status === 204) {
    return { success: true, data: undefined as T, status: 204 };
  }

  // HF Space "uyku" veya boot durumunda HF edge katmanı 502/503/504 + HTML
  // gövdesi döner ("Your space is in error, check its status on hf.co"). Bu
  // bir uygulama hatası değil, geçici altyapı durumu. JSON parse'tan ÖNCE
  // yakalayıp stable bir sentinel string döndürüyoruz: üst katmanlar (auth
  // localizer, useServerWakeUp hook) bu prefix'i okuyup retry/UI kararı verir.
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return {
      success: false,
      error: `service_unavailable: HTTP ${res.status}`,
      status: res.status,
    } as APIResponse<T>;
  }

  try {
    const data: APIResponse<T> = await res.json();
    // Tag status on the JSON envelope so downstream helpers (retry, rate
    // limit toast) can branch on the HTTP code without string-matching.
    data.status = res.status;
    return data;
  } catch {
    // text/html dönmüşse büyük ihtimalle HF/proxy hata sayfasıdır — yine
    // sentinel'e düş ki UI ham HTML değil dostça mesaj göstersin.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      console.error(`[apiClient] ${method} ${endpoint}: HTML response (HTTP ${res.status})`);
      return {
        success: false,
        error: `service_unavailable: HTTP ${res.status}`,
        status: res.status,
      } as APIResponse<T>;
    }
    console.error(`[apiClient] ${method} ${endpoint}: invalid JSON (HTTP ${res.status})`);
    return {
      success: false,
      error: `HTTP ${res.status}: ${res.statusText}`,
      status: res.status,
    } as APIResponse<T>;
  }
}

/**
 * Checks if a JWT access token is expired.
 * Includes a 10s buffer so tokens about to expire are treated as expired,
 * preventing requests that expire mid-transport.
 */
function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp * 1000 < Date.now() + 10_000;
  } catch {
    return true;
  }
}

/**
 * Proactive-refresh window. With a 24h access token we refresh ~5 minutes
 * before expiry rather than waiting for the first 401 — that way the user
 * never sees the "Unauthorized" toast that the old reactive refresh
 * surfaced for the duration of the in-flight request when their tab had
 * been idle past the access TTL.
 *
 * Short-lived tokens (e.g. operator-tightened 15-minute deploys) still
 * refresh just-in-time because the window won't trigger until they're
 * already inside it.
 */
const PROACTIVE_REFRESH_WINDOW_MS = 5 * 60 * 1000;

function isTokenAboutToExpire(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp * 1000 < Date.now() + PROACTIVE_REFRESH_WINDOW_MS;
  } catch {
    return true;
  }
}

/**
 * Ensures a valid access token exists, refreshing if needed.
 *
 * Used before WebSocket connections — unlike HTTP requests, WS connections
 * don't return 401 on expired tokens, they just get rejected, causing
 * infinite reconnect loops.
 */
async function ensureFreshToken(): Promise<string | null> {
  const token = getAccessToken();
  if (!token) return null;

  if (!isTokenExpired(token)) return token;

  const refreshed = await refreshAccessToken();
  if (!refreshed) return null;

  return getAccessToken();
}

export { setTokens, clearTokens, getAccessToken, ensureFreshToken };
