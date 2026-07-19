import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import "./i18n"; // Must be imported before App for i18n initialization
import "./styles/globals.css";
import "./utils/screenShareCursorPatch"; // Wire user's cursor preference into getDisplayMedia
import "./stores/accessibilityStore"; // Side-effect: applyAccessibility(initial) on module load
import App from "./App";
import ErrorBoundary from "./components/shared/ErrorBoundary";
import { isNativeApp } from "./utils/constants";
import { configureMobileUI, initAppLifecycle } from "./utils/nativePlugins";
import { installGlobalErrorLogger } from "./api/globalErrorLogger";
import { installScreenPickerDiagnosticForwarder } from "./api/screenPickerDiagnostic";

// Native shells (Electron file://, Capacitor capacitor://) don't support HTML5 History API.
// Web uses BrowserRouter for clean URLs. Capitalized (JSX requires it for <Router>) but
// never exported or Fast-Refreshed -- this is the app entry point, mounted once.
// eslint-disable-next-line react-refresh/only-export-components
const Router = isNativeApp() ? HashRouter : BrowserRouter;

// Configure mobile-specific UI (safe area insets, status bar, keyboard) — no-op on web/Electron
configureMobileUI();

// Initialize app lifecycle listeners (background/foreground, back button) — no-op on web/Electron
initAppLifecycle();

// Capture window-level errors / unhandled rejections / online-offline events
// for the admin Uygulama Günlükleri panel. Idempotent — safe under StrictMode.
installGlobalErrorLogger();

// Forward main-process screen picker diagnostics to /client-log. Only
// active in Electron; no-op otherwise. Idempotent. See plan
// info-ws-ramses-user-spicy-cascade.md for the diagnosis flow.
installScreenPickerDiagnosticForwarder();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <Router>
        <App />
      </Router>
    </ErrorBoundary>
  </StrictMode>
);
