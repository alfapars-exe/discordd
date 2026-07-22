/**
 * returnUrl — validation helpers for the `?returnUrl=` query param used by
 * LoginPage/RegisterPage to send the user back where they came from (e.g. an
 * invite link) after auth.
 *
 * `returnUrl` is attacker-controlled (it's a URL query string), so it must
 * never be handed to `navigate()` unchecked — otherwise a crafted link like
 * `?returnUrl=https://evil.example` or `?returnUrl=//evil.example` becomes
 * an open redirect.
 */

/** Fallback destination when `returnUrl` is missing or unsafe. */
export const DEFAULT_RETURN_PATH = "/channels";

/** Exact-match invite path: `/invite/{16 hex chars}` — no loose prefix check. */
const INVITE_RETURN_URL_PATTERN = /^\/invite\/([a-f0-9]{16})$/;

/**
 * Returns `raw` if it resolves to this origin, otherwise `DEFAULT_RETURN_PATH`.
 *
 * Validation is origin-based, not prefix-based, because a `startsWith("//")`
 * check is bypassable: the URL parser normalises `/\evil.example` (backslash)
 * and `/<TAB>/evil.example` (TAB/LF/CR are stripped before parsing, and
 * `searchParams.get` already decoded `%09` into a real TAB) into the
 * protocol-relative `//evil.example`. Those slipped past the old guard and
 * reached `navigate()`, where react-router v7 catches the cross-origin
 * `pushState` SecurityError and falls back to `window.location.assign` — a
 * genuine open redirect, not merely a broken client-side route.
 *
 * Resolving against the current origin and comparing `origin` collapses every
 * such encoding to one question: does this land on us or somewhere else?
 */
export function sanitizeReturnUrl(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) {
    return DEFAULT_RETURN_PATH;
  }

  // No window (non-browser test env): can't establish an origin to compare
  // against, so fall back rather than guess.
  if (typeof window === "undefined") {
    return DEFAULT_RETURN_PATH;
  }

  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) {
      return DEFAULT_RETURN_PATH;
    }

    // Return the re-serialised path, not `raw` — the parser has already
    // normalised away the control characters and backslashes we rejected on.
    const path = url.pathname + url.search + url.hash;

    // The origin check alone is not sufficient, because serialising the path
    // back out strips the origin off again: dot-segment normalisation turns
    // "/..//evil.example" into pathname "//evil.example" while `url.origin`
    // stays same-origin (verified: "/..//", "/.//" and "/a/..//" all do this).
    // Handing that to navigate() would be a protocol-relative URL once more.
    if (path.startsWith("//")) {
      return DEFAULT_RETURN_PATH;
    }

    return path;
  } catch {
    return DEFAULT_RETURN_PATH;
  }
}

/**
 * If `raw` is exactly an invite path (`/invite/{16 hex chars}`), returns the
 * captured invite code; otherwise `null`. Used to auto-join a server right
 * after registration instead of bouncing the user back to the invite page.
 */
export function matchInviteReturnUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = INVITE_RETURN_URL_PATTERN.exec(raw);
  return match ? match[1] : null;
}
