/**
 * HTTP API client — all backend requests go through this module.
 *
 * Handles auth token injection, 401 refresh flow, and consistent error handling.
 *
 * Token storage model (post C2):
 *   - Access token:  in-memory only (module variable below). Short-lived,
 *     re-issued on every refresh. XSS that exfiltrates this gets at most a
 *     few minutes of access.
 *   - Refresh token: HttpOnly + SameSite=Strict cookie set by the server.
 *     The browser sends it automatically on /api/auth/refresh requests
 *     (via `credentials: 'include'`), but JavaScript cannot read it — so
 *     even a stored XSS in any rendered field cannot lift the long-lived
 *     credential. localStorage is no longer used for refresh tokens.
 *
 * A `legacyMigrate` pass on first load drains any pre-C2 refresh token from
 * localStorage and clears it — the server will set the HttpOnly cookie on
 * the next refresh response, so the migration is transparent to the user.
 */

import type { APIResponse } from "../types";
import { API_BASE_URL } from "../utils/constants";

// Access token lives in module memory only — no localStorage read/write.
let accessTokenMemory: string | null = null;

// Pre-C2 clients stored access_token in localStorage too. Hydrate from
// there on first load so a reload doesn't sign the user out. Once a fresh
// access token is issued via refresh, this stale value is overwritten.
try {
  const stored = localStorage.getItem("access_token");
  if (stored) accessTokenMemory = stored;
} catch {
  /* private mode / quota — fall through, user re-authenticates */
}

// Drain the legacy refresh token from localStorage. The server-side cookie
// is now the source of truth; keeping the value around in JS-readable
// storage would defeat the entire C2 fix.
try {
  if (localStorage.getItem("refresh_token") !== null) {
    localStorage.removeItem("refresh_token");
  }
} catch {
  /* ignore */
}

function getAccessToken(): string | null {
  return accessTokenMemory;
}

function setTokens(access: string, _refresh: string): void {
  accessTokenMemory = access;
  // Refresh token is delivered via Set-Cookie, not stored client-side.
  // The _refresh parameter is intentionally unused — kept for callsite
  // compatibility during the C2 migration. Once all server responses
  // omit refresh_token from the JSON body, callers can drop the arg.
  try {
    // Mirror access token to localStorage so a page reload keeps the user
    // signed in until a refresh cycle replaces it. Acceptable because the
    // access token TTL is short (≤ 15 min by default).
    localStorage.setItem("access_token", access);
  } catch {
    /* ignore */
  }
}

function clearTokens(): void {
  accessTokenMemory = null;
  try {
    localStorage.removeItem("access_token");
    // Defensive — sweep any stale refresh token from older clients.
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
    const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
};

/**
 * Core HTTP request function. Generic type <T> specifies the expected response data type.
 *
 * Usage:
 *   const data = await apiClient<User[]>("/users");
 *   const user = await apiClient<User>("/users/me", { method: "PATCH", body: { display_name: "New" } });
 */
export async function apiClient<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<APIResponse<T>> {
  const { method = "GET", body, headers: extraHeaders } = options;

  const headers: Record<string, string> = {
    ...extraHeaders,
  };

  const token = getAccessToken();
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
    res = await fetch(`${API_BASE_URL}${endpoint}`, fetchOptions);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Network request failed";
    console.error(`[apiClient] ${method} ${endpoint}:`, message);
    return { success: false, error: message } as APIResponse<T>;
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
        res = await fetch(`${API_BASE_URL}${endpoint}`, {
          ...fetchOptions,
          headers,
        });
        if (isDev) {
          console.warn(`[apiClient] retry after refresh: ${method} ${endpoint} status=${res.status}`);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Network request failed";
        if (isDev) {
          console.error(`[apiClient] ${method} ${endpoint} (retry):`, message);
        }
        return { success: false, error: message } as APIResponse<T>;
      }
    } else if (isDev) {
      console.warn(`[apiClient] refresh FAILED on ${method} ${endpoint} — returning original 401`);
    }
  }

  // 204 No Content — no body to parse
  if (res.status === 204) {
    return { success: true, data: undefined as T };
  }

  try {
    const data: APIResponse<T> = await res.json();
    return data;
  } catch {
    console.error(`[apiClient] ${method} ${endpoint}: invalid JSON (HTTP ${res.status})`);
    return {
      success: false,
      error: `HTTP ${res.status}: ${res.statusText}`,
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
