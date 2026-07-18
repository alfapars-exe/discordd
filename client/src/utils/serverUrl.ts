/**
 * serverUrl — validation + probing helpers for the self-host server picker.
 *
 * Lives outside ServerUrlPicker.tsx so the component file only exports a
 * component (react-refresh/only-export-components) and the pure logic can
 * be unit-tested without rendering.
 */

const PROBE_TIMEOUT_MS = 5_000;

export type ProbeError = "unreachable" | "not_a_hichat_server" | "invalid_url" | "empty";

export async function probeServer(url: string): Promise<ProbeError | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/version`, {
      signal: controller.signal,
      credentials: "omit",
    });
    if (!res.ok) return "unreachable";
    const body = await res.json().catch(() => null);
    // Every HiChat backend serves { service: "hichat", ... } from /api/version.
    // Anything else is a wrong-server / phishing surface.
    if (body?.service !== "hichat") return "not_a_hichat_server";
    return null;
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalizes user-typed URLs so common typos still work:
 *   - "myserver.com" → "https://myserver.com"
 *   - "http://myserver.com/" → "http://myserver.com" (trailing slash)
 * Rejects empty and clearly-malformed input up front.
 */
export function normalizeServerUrl(input: string): { ok: true; url: string } | { ok: false; reason: ProbeError } {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };

  // Reject explicit non-http(s) schemes up front — otherwise "ftp://x"
  // silently becomes "https://ftp:/x" after we prepend a scheme, and the
  // user's intent (a wrong protocol) is masked instead of surfaced.
  // "app://" would be a subtle privilege footgun in a picker that runs
  // in the same renderer as our custom scheme.
  if (/^\w+:/.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return { ok: false, reason: "invalid_url" };
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "invalid_url" };
    }
    if (!parsed.hostname) {
      return { ok: false, reason: "invalid_url" };
    }
    // Drop trailing slash so it doesn't double up when API_BASE_URL is composed.
    const canonical = parsed.toString().replace(/\/$/, "");
    return { ok: true, url: canonical };
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
}
