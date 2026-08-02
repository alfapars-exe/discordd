/**
 * Main-process login for the "Remember Me" path (pentest 2026-07-26, H-09).
 *
 * The renderer used to fetch the saved password over IPC and log in itself.
 * That put a long-lived account password in the renderer's heap on every
 * launch, so any XSS in `app://hichat` walked away with it — which defeats the
 * point of keeping only short-lived access tokens there.
 *
 * The password now never crosses the bridge. The renderer asks for a login,
 * this module reads the credentials, talks to the upstream server itself, and
 * hands back only what the renderer already gets from a normal login: the
 * tokens and the user record.
 *
 * The request goes through the same net.fetch path the API proxy uses, with
 * `credentials: "include"`, so the refresh cookie lands in the session jar the
 * renderer shares — exactly as if the renderer had made the call.
 */
import { loadCredentials, type Credentials } from "./credentials";
import { DEFAULT_UPSTREAM, sanitizeUpstreamOrigin } from "./api-proxy";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * What the renderer receives. Deliberately mirrors the upstream login response
 * and nothing else — no password, and no echo of the stored username beyond
 * what the server itself returns inside `body`.
 */
export interface SavedLoginResult {
  /** HTTP status from the upstream login call. */
  status: number;
  /** Parsed JSON body, or null when the response had none. */
  body: unknown;
}

/** Raised when there is nothing stored to log in with. */
export const NO_SAVED_CREDENTIALS = "no-saved-credentials";

/**
 * Performs a login using the credentials in OS-encrypted storage.
 *
 * `upstreamOrigin` comes from the renderer, which is why it goes through the
 * same sanitizer the proxy applies to the X-HiChat-Upstream header rather than
 * being trusted: a compromised renderer must not be able to aim a login — and
 * therefore the stored password — at a host of its choosing. An unusable value
 * falls back to DEFAULT_UPSTREAM instead of failing, matching proxyApiRequest.
 */
export async function loginWithSavedCredentials(
  upstreamOrigin: unknown,
  fetchImpl: FetchLike,
  {
    allowLoopback = false,
    loadCreds = loadCredentials,
  }: { allowLoopback?: boolean; loadCreds?: () => Credentials | null } = {}
): Promise<SavedLoginResult> {
  const creds = loadCreds();
  if (!creds) {
    throw new Error(NO_SAVED_CREDENTIALS);
  }

  const origin =
    sanitizeUpstreamOrigin(
      typeof upstreamOrigin === "string" ? upstreamOrigin : null,
      { allowLoopback }
    ) ?? DEFAULT_UPSTREAM;

  const response = await fetchImpl(`${origin}/api/auth/login`, {
    method: "POST",
    // No X-HiChat-Upstream header: that one exists so the renderer can tell
    // the proxy where to relay. This call goes straight to the origin, and the
    // proxy strips the header before forwarding anyway.
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: creds.username,
      password: creds.password,
    }),
    credentials: "include",
    redirect: "follow",
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A login that returns no JSON (proxy error page, 502 from an edge) is
    // reported to the renderer as a status with a null body rather than
    // throwing, so it can show the same failure UI as a wrong password.
    body = null;
  }

  return { status: response.status, body };
}
