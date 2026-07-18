/**
 * ServerUrlPicker — Native-only foldable row on the login/register pages
 * for self-hosters to point the desktop app at a non-default backend.
 *
 * Rationale: the .exe is a signed binary — end users can't edit constants
 * or set env vars. Without this, they'd have to install their own build
 * to point at a home-server. The picker writes to localStorage under the
 * historical key `mqvi_server_url` so constants.ts:resolveServerUrl picks
 * it up on next boot.
 *
 * Web mode: not rendered at all (returns null). Web users hit whatever
 * origin they browsed to.
 *
 * Validation: before saving, probes GET {url}/api/version with a 5s
 * timeout. Two distinct failure modes so users can act on the message:
 *   - unreachable          → wrong URL, offline, CORS-blocked
 *   - not_a_hichat_server  → reachable, but response isn't the version
 *                            envelope we expect (someone typo'd a URL
 *                            pointing at their router's admin panel)
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_SERVER_URL, isNativeApp } from "../../utils/constants";

const PROBE_TIMEOUT_MS = 5_000;
const STORAGE_KEY = "mqvi_server_url";

type ProbeError = "unreachable" | "not_a_hichat_server" | "invalid_url" | "empty";

async function probeServer(url: string): Promise<ProbeError | null> {
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

function ServerUrlPicker() {
  const { t } = useTranslation("auth");
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState(() => localStorage.getItem(STORAGE_KEY) ?? "");
  const [busy, setBusy] = useState(false);
  const [errorKind, setErrorKind] = useState<ProbeError | null>(null);

  if (!isNativeApp()) return null;

  const currentValue = localStorage.getItem(STORAGE_KEY) ?? DEFAULT_SERVER_URL;

  async function handleSave() {
    setErrorKind(null);
    const normalized = normalizeServerUrl(input);
    if (!normalized.ok) {
      setErrorKind(normalized.reason);
      return;
    }
    setBusy(true);
    const probeResult = await probeServer(normalized.url);
    setBusy(false);
    if (probeResult) {
      setErrorKind(probeResult);
      return;
    }
    // SERVER_URL is captured in a module-level constant at boot; changing
    // it mid-session would only take effect next reload. Reload after save.
    localStorage.setItem(STORAGE_KEY, normalized.url);
    window.location.reload();
  }

  function handleReset() {
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  }

  return (
    <div className="server-url-picker" data-testid="server-url-picker">
      <button
        type="button"
        className="server-url-picker__toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {t("serverUrlPicker.toggle")}: <span>{currentValue}</span>
      </button>
      {expanded && (
        <div className="server-url-picker__body">
          <label className="server-url-picker__label">
            {t("serverUrlPicker.label")}
            <input
              type="url"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setErrorKind(null);
              }}
              placeholder={DEFAULT_SERVER_URL}
              disabled={busy}
              data-testid="server-url-picker-input"
            />
          </label>
          {errorKind && (
            <p
              className="server-url-picker__error"
              data-testid="server-url-picker-error"
              data-error-kind={errorKind}
            >
              {t(`serverUrlPicker.error.${errorKind}`)}
            </p>
          )}
          <div className="server-url-picker__actions">
            <button type="button" onClick={handleSave} disabled={busy}>
              {busy ? t("serverUrlPicker.probing") : t("serverUrlPicker.save")}
            </button>
            <button type="button" onClick={handleReset} disabled={busy}>
              {t("serverUrlPicker.reset")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ServerUrlPicker;
