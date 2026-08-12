/**
 * ErrorBoundary — Catches render crashes, reports them, and auto-reloads.
 *
 * Behavior:
 *   1. Logs the error to the server (`client_render_crash`) so admins can see
 *      what actually crashed instead of guessing from user screenshots.
 *   2. Auto-reloads after 2 s for a one-shot crash recovery.
 *   3. If we've reloaded ≥3 times in the past 30 s the page is in a crash
 *      loop — stop reloading and surface a "stuck" UI with manual recovery
 *      actions instead of pinning the user in an endless flash of "Reloading…".
 *
 * Must be a class component (React limitation for error boundaries).
 */

import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { logToServer } from "../../api/clientLog";
// i18n is a module singleton with bundled en/tr resources, so calling
// i18n.t() here is safe even though this boundary mounts above the Router
// (no provider/hook available in a class component this high in the tree).
import i18n from "../../i18n";
import { captureBoundaryError } from "../../monitoring/sentry";

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
  // True when reloads keep crashing the page — show recovery UI instead of
  // looping. Reset only by manual user action.
  stuck: boolean;
};

const RELOAD_KEY = "errorBoundaryReloads";
const RELOAD_WINDOW_MS = 30_000;
const MAX_RELOADS_IN_WINDOW = 2;

function readRecentReloads(): number[] {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((t): t is number => typeof t === "number" && now - t < RELOAD_WINDOW_MS);
  } catch {
    return [];
  }
}

function writeRecentReloads(reloads: number[]): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify(reloads));
  } catch {
    /* private mode or quota — fall through */
  }
}

class ErrorBoundary extends Component<Props, State> {
  private reloadTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, stuck: false };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught render error:", error, errorInfo);

    // DSN-gated — no-op when Sentry isn't configured.
    captureBoundaryError(error, errorInfo);

    // Server-side telemetry — we can't see mobile DevTools, so without this
    // the crash is invisible to admins. logToServer swallows its own errors.
    logToServer("error", "client_render_crash", {
      errorMessage: error.message?.slice(0, 500) ?? "",
      errorName: error.name,
      errorStack: error.stack?.slice(0, 2000) ?? "",
      componentStack: errorInfo.componentStack?.slice(0, 2000) ?? "",
      url: window.location.pathname + window.location.search,
    });

    const reloads = readRecentReloads();
    if (reloads.length >= MAX_RELOADS_IN_WINDOW) {
      // Crash loop — stop the reload pump, ask the user to recover manually.
      try {
        sessionStorage.removeItem(RELOAD_KEY);
      } catch {
        /* ignore */
      }
      this.setState({ stuck: true });
      return;
    }

    reloads.push(Date.now());
    writeRecentReloads(reloads);

    this.reloadTimerId = setTimeout(() => {
      window.location.reload();
    }, 2000);
  }

  componentWillUnmount() {
    if (this.reloadTimerId) {
      clearTimeout(this.reloadTimerId);
    }
  }

  // Manual recovery: clear local app state (which is what was driving the
  // crash loop — usually a stale voice channel id resurrected by F5 recovery)
  // and reload once with cache bypass.
  private handleRecover = () => {
    try {
      sessionStorage.clear();
      // Targeted localStorage prune — full clear would log the user out.
      // The keys below are the ones known to feed render-time state that can
      // crash if stale; everything else (auth, theme, prefs) survives.
      ["voiceStore", "voice-store", "currentVoiceChannelId"].forEach((k) => {
        try {
          localStorage.removeItem(k);
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    // Cache-bust query string forces a fresh index.html fetch from the SW or
    // HTTP cache regardless of Cache-Control headers.
    //
    // Built via the URL API (not string concatenation of pathname+search)
    // so the current origin is preserved even when pathname starts with
    // "//" — e.g. https://host//evil.com/ has pathname "//evil.com/", and
    // `window.location.href = pathname + ...` would assign a protocol-
    // relative URL that redirects cross-origin. searchParams.set also
    // replaces (rather than appends) `_eb` on repeated recovery clicks.
    const url = new URL(window.location.href);
    url.searchParams.set("_eb", String(Date.now()));
    window.location.assign(url);
  };

  render() {
    if (this.state.stuck) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            padding: "24px",
            textAlign: "center",
            backgroundColor: "var(--color-background)",
            color: "var(--color-text-primary)",
            fontSize: "14px",
            gap: "16px",
          }}
        >
          <div style={{ fontSize: "16px", fontWeight: 600 }}>
            {i18n.t("common:errorBoundary.stuckTitle", {
              defaultValue: "The app ran into a problem while loading",
            })}
          </div>
          <div style={{ maxWidth: "320px", opacity: 0.8 }}>
            {i18n.t("common:errorBoundary.stuckBody", {
              defaultValue:
                "Let's try again. This clears stale tab state and reloads the page — you won't be signed out.",
            })}
          </div>
          <button
            type="button"
            onClick={this.handleRecover}
            style={{
              padding: "10px 18px",
              borderRadius: "8px",
              border: "none",
              cursor: "pointer",
              fontSize: "14px",
              fontWeight: 600,
              backgroundColor: "var(--color-primary, #5865f2)",
              color: "#fff",
            }}
          >
            {i18n.t("common:errorBoundary.retry", { defaultValue: "Try again" })}
          </button>
        </div>
      );
    }

    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            backgroundColor: "var(--color-background)",
            color: "var(--color-text-primary)",
            fontSize: "15px",
          }}
        >
          {i18n.t("common:errorBoundary.reloading", { defaultValue: "Reloading..." })}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
