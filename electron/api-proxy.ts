/**
 * api-proxy — forwards renderer requests for app://hichat/api/* to the real
 * backend from the MAIN process.
 *
 * Why this exists (2026-07-19, "Ağ hatası" login outage): the production
 * backend sits behind Hugging Face's edge proxy, and that edge answers every
 * CORS preflight (OPTIONS) itself — our Go server never sees them. The
 * synthesized preflight response omits `Access-Control-Allow-Credentials`,
 * and Chromium hard-fails any credentialed preflighted request on that
 * omission. Every desktop API call is credentialed (HttpOnly refresh cookie)
 * AND preflighted (X-HiChat-Client header + JSON body), so the entire app
 * was dead on arrival. Proof: the same rs/cors config emits the header
 * locally (server/bootstrap_cors_test.go) while prod preflights lack it and
 * carry a `max-age: 600` we never configured.
 *
 * The fix removes CORS from the equation entirely: the renderer fetches its
 * OWN origin (app://hichat/api/...), which is same-origin — no preflight is
 * ever generated — and this module relays the request upstream via net.fetch
 * with `credentials: "include"`, so cookies live in the session jar keyed by
 * the real backend host, exactly as before.
 *
 * The upstream target rides in the X-HiChat-Upstream request header (set by
 * client/src/api/client.ts). A header, not IPC state, so the renderer's
 * server picker is the single source of truth and there is no boot-ordering
 * race between "renderer told main the server URL" and "first API call".
 *
 * Kept free of `electron` imports so it runs under plain node:test like
 * resolve-path.ts — main.ts injects net.fetch.
 */

import { APP_HOST, APP_SCHEME } from "./resolve-path";

/** Must match client/src/api/client.ts UPSTREAM_HEADER. */
export const UPSTREAM_HEADER = "x-hichat-upstream";

/**
 * Fallback when the header is missing (should not happen with the paired
 * client build, but a hardcoded default beats a dead request). Mirrors
 * DEFAULT_SERVER_URL in client/src/utils/constants.ts.
 */
export const DEFAULT_UPSTREAM = "https://infinayazilim-discord.hf.space";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** True for the API subtree we relay; everything else is a static asset. */
export function isProxyableUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== APP_SCHEME || parsed.hostname !== APP_HOST) {
    return false;
  }
  return parsed.pathname === "/api" || parsed.pathname.startsWith("/api/");
}

/**
 * Validates the renderer-supplied upstream and reduces it to a bare origin.
 *
 * The renderer is our own code, but this value still steers where the main
 * process sends requests, so it gets the same treatment as any input:
 *  - https only, except plain-http loopback for local dev servers. The
 *    renderer CSP (connect-src) never allowed plain http either, so this
 *    widens nothing.
 *  - no embedded credentials (user:pass@host smuggling).
 *  - path/query/fragment are discarded — only the origin survives.
 */
export function sanitizeUpstreamOrigin(raw: string | null): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.username !== "" || parsed.password !== "") return null;
  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    return null;
  }
  return parsed.origin;
}

/** app://hichat/api/x?y=1 + https://host → https://host/api/x?y=1 */
export function buildUpstreamUrl(rawUrl: string, upstreamOrigin: string): string {
  const parsed = new URL(rawUrl);
  return `${upstreamOrigin}${parsed.pathname}${parsed.search}`;
}

/**
 * Relays one renderer API request upstream and returns the response.
 *
 * Header hygiene, both directions:
 *  - X-HiChat-Upstream is transport routing, not API payload — stripped.
 *  - Cookie is stripped from the outgoing request: `credentials: "include"`
 *    makes the network layer attach the canonical cookies stored for the
 *    upstream host. Forwarding the renderer's (app://hichat-keyed, normally
 *    empty) Cookie header could produce a second, stale refresh_token after
 *    a rotation.
 *  - Set-Cookie is stripped from the response for the mirror-image reason:
 *    the network layer has already stored it against the upstream host;
 *    letting it through would double-store under app://hichat and the two
 *    copies would desync on the next rotation.
 *
 * A rejected upstream fetch is rethrown: protocol.handle turns a throwing
 * handler into a failed request, so the renderer sees the same
 * "Failed to fetch" it would get talking to the backend directly — the
 * existing isNetworkError / offline UX paths keep working unchanged.
 */
export async function proxyApiRequest(
  request: Request,
  fetchImpl: FetchLike
): Promise<Response> {
  const upstreamOrigin =
    sanitizeUpstreamOrigin(request.headers.get(UPSTREAM_HEADER)) ?? DEFAULT_UPSTREAM;
  const target = buildUpstreamUrl(request.url, upstreamOrigin);

  const headers = new Headers(request.headers);
  headers.delete(UPSTREAM_HEADER);
  headers.delete("cookie");

  const init: RequestInit & { duplex?: "half"; bypassCustomProtocolHandlers?: boolean } = {
    method: request.method,
    headers,
    credentials: "include",
    redirect: "follow",
    bypassCustomProtocolHandlers: true,
  };
  if (request.body !== null && request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // Streaming request bodies require explicit half-duplex per the fetch
    // spec; without it the Request constructor inside net.fetch throws.
    init.duplex = "half";
  }

  const upstream = await fetchImpl(target, init);

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("set-cookie");
  // The Response constructor rejects a non-null body for these statuses.
  const nullBodyStatus =
    upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new Response(nullBodyStatus ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
