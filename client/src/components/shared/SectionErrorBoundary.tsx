/**
 * SectionErrorBoundary — Per-section render-crash isolation.
 *
 * Unlike the app-level ErrorBoundary there is deliberately NO auto-reload
 * pump here: a crash inside one section (chat, settings, voice) renders an
 * inline fallback and leaves the rest of the app usable. Retry remounts the
 * subtree via a render-key bump so transient crashes recover in place
 * without losing the whole session to a page reload.
 *
 * Must be a class component (React limitation for error boundaries).
 */

import { Component, Fragment } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { logToServer } from "../../api/clientLog";
// i18n is a module singleton with bundled en/tr resources — usable from a
// class component without the react-i18next hook/provider.
import i18n from "../../i18n";
import { captureBoundaryError } from "../../monitoring/sentry";

type Props = {
  section: string;
  children: ReactNode;
};

type State = {
  hasError: boolean;
  // Bumped on retry so children fully remount instead of re-rendering the
  // crashed tree with whatever internal state drove the crash.
  renderKey: number;
};

class SectionErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, renderKey: 0 };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      `[SectionErrorBoundary:${this.props.section}] Uncaught render error:`,
      error,
      errorInfo
    );

    // DSN-gated — no-op when Sentry isn't configured.
    captureBoundaryError(error, errorInfo);

    // Same server-side telemetry as the app-level boundary — without it a
    // section crash on mobile/desktop builds is invisible to admins.
    logToServer("error", "client_section_crash", {
      section: this.props.section,
      errorMessage: error.message?.slice(0, 500) ?? "",
      errorName: error.name,
      errorStack: error.stack?.slice(0, 2000) ?? "",
      componentStack: errorInfo.componentStack?.slice(0, 2000) ?? "",
      url: window.location.pathname + window.location.search,
    });
  }

  private handleRetry = () => {
    this.setState((s) => ({ hasError: false, renderKey: s.renderKey + 1 }));
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            flex: 1,
            minHeight: 120,
            padding: "24px",
            textAlign: "center",
            color: "var(--color-text-primary)",
            fontSize: "14px",
            gap: "12px",
          }}
        >
          <div>
            {i18n.t("common:errorBoundary.sectionTitle", {
              section: this.props.section,
              defaultValue: "Something went wrong in this section ({{section}})",
            })}
          </div>
          <button
            type="button"
            onClick={this.handleRetry}
            style={{
              padding: "8px 16px",
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

    // Keyed fragment forces a clean remount of the section subtree on retry.
    return <Fragment key={this.state.renderKey}>{this.props.children}</Fragment>;
  }
}

export default SectionErrorBoundary;
