import { useEffect, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./stores/authStore";
import { useSettingsStore } from "./stores/settingsStore";
import CustomTitleBar from "./components/layout/CustomTitleBar";
import UpdateBanner from "./components/shared/UpdateBanner";
import { isElectron, isNativeApp } from "./utils/constants";
import { logToServer } from "./api/clientLog";

// Lazy-load route components so each path bundles separately. The
// initial JS that has to ship before the first paint is just App.tsx +
// the auth-stores + the title bar / update banner — everything else
// arrives only when its route is matched. Trade-off: a 50-150ms
// loading flash on first route entry (mitigated by the shared
// spinner fallback below) in exchange for ~40% smaller first paint.
const LandingPage = lazy(() => import("./components/landing/LandingPage"));
const PrivacyPage = lazy(() => import("./components/landing/PrivacyPage"));
const TermsPage = lazy(() => import("./components/landing/TermsPage"));
const LoginPage = lazy(() => import("./components/auth/LoginPage"));
const RegisterPage = lazy(() => import("./components/auth/RegisterPage"));
const ForgotPasswordPage = lazy(() => import("./components/auth/ForgotPasswordPage"));
const ResetPasswordPage = lazy(() => import("./components/auth/ResetPasswordPage"));
const InviteJoinPage = lazy(() => import("./components/servers/InviteJoinPage"));
const AppLayout = lazy(() => import("./components/layout/AppLayout"));

/**
 * App — Root component. Handles routing and auth initialization.
 * Shows loading spinner until auth state is resolved, then routes
 * to /channels (authenticated) or /login (unauthenticated).
 */
function App() {
  const { t } = useTranslation("common");
  const initialize = useAuthStore((s) => s.initialize);
  const isInitialized = useAuthStore((s) => s.isInitialized);
  const initPhase = useAuthStore((s) => s.initPhase);
  const user = useAuthStore((s) => s.user);
  const blurEnabled = useSettingsStore((s) => s.blurEnabled);
  const transparentBackground = useSettingsStore((s) => s.transparentBackground);

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Drain any persisted crash record from the previous Electron launch and
  // ship it to /api/client-log. Fires on every transition to authenticated
  // state — the IPC handler atomically reads+deletes the file, so a second
  // call sees null. The crash that triggered the previous shutdown is
  // ALWAYS reported here; live crashes never go through this path.
  //
  // The message embeds kind/reason/processType so the admin panel's list
  // view (which shows the message column only) is self-describing —
  // before this the row read `electron_crash` and you had to open the
  // metadata blob to learn what actually died. Prefix stays
  // `electron_crash:` so existing greps still match.
  useEffect(() => {
    if (!user || !isElectron()) return;
    const api = window.electronAPI;
    if (!api?.consumeLastCrash) return;
    api
      .consumeLastCrash()
      .then((record) => {
        if (!record) return;
        const level =
          record.kind === "render-process-gone" ? "error" : "warn";
        const messageParts = ["electron_crash", record.kind, record.reason];
        if (record.processType) messageParts.push(record.processType);
        const message = messageParts.join(":");
        logToServer(level, message, {
          kind: record.kind,
          reason: record.reason,
          exitCode: record.exitCode,
          serviceName: record.serviceName,
          processType: record.processType,
          occurredAt: record.occurredAt,
          dumpFile: record.dumpFile,
        });
      })
      .catch(() => {
        /* IPC failure is non-fatal — next launch will retry if needed */
      });
  }, [user]);

  // Apply blur + transparent classes at root level so they also affect
  // pre-auth pages (login, register, landing).
  useEffect(() => {
    document.body.classList.toggle("blur-enabled", blurEnabled);
    document.body.classList.toggle("blur-disabled", !blurEnabled);
  }, [blurEnabled]);

  useEffect(() => {
    document.documentElement.classList.toggle("transparent-bg", transparentBackground);
    document.body.classList.toggle("transparent-bg", transparentBackground);
  }, [transparentBackground]);

  if (!isInitialized) {
    const spinner = (
      <div className="flex h-full items-center justify-center bg-background" style={{ flex: 1, minHeight: 0 }}>
        <div className="text-center">
          <div className="mx-auto mb-6 h-14 w-14 animate-spin rounded-full border-4 border-surface border-t-brand" />
          <p className="text-base text-text-muted">
            {initPhase === "waking" ? t("serverWaking", { defaultValue: t("loading") }) : t("loading")}
          </p>
        </div>
      </div>
    );

    if (isElectron()) {
      return (
        <div className="electron-app-wrapper">
          <CustomTitleBar />
          {spinner}
        </div>
      );
    }

    return spinner;
  }

  // Update banner (downloading + ready states for Electron, redeploy nudge
  // for web) is rendered globally inside AppLayout via <UpdateBanner />.
  // No need for App.tsx to wire it separately — single source of truth.

  const routes = (
    <Routes>
      {/* Landing — native apps (Electron/Capacitor) skip to login directly */}
      <Route
        path="/"
        element={
          user ? (
            <Navigate to="/channels" replace />
          ) : isNativeApp() ? (
            <Navigate to="/login" replace />
          ) : (
            <LandingPage />
          )
        }
      />

      {/* Auth pages — unauthenticated only */}
      <Route
        path="/login"
        element={user ? <Navigate to="/channels" replace /> : <LoginPage />}
      />
      <Route
        path="/register"
        element={user ? <Navigate to="/channels" replace /> : <RegisterPage />}
      />
      <Route
        path="/forgot-password"
        element={user ? <Navigate to="/channels" replace /> : <ForgotPasswordPage />}
      />
      <Route
        path="/reset-password"
        element={user ? <Navigate to="/channels" replace /> : <ResetPasswordPage />}
      />

      {/* Legal pages — public */}
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />

      {/* Invite join — auth check is handled inside InviteJoinPage */}
      <Route path="/invite/:code" element={<InviteJoinPage />} />

      {/* Main app — authenticated only */}
      <Route
        path="/channels/*"
        element={user ? <AppLayout /> : <Navigate to="/login" replace />}
      />

      {/* Default redirect — unknown routes */}
      <Route
        path="*"
        element={
          <Navigate to={user ? "/channels" : isNativeApp() ? "/login" : "/"} replace />
        }
      />
    </Routes>
  );

  // Shared Suspense fallback — the same spinner shown during auth init.
  // Re-using it keeps the perceived transition consistent regardless of
  // whether the lazy chunk arrives in 5ms (cached) or 500ms (cold load).
  const lazyFallback = (
    <div className="flex h-full items-center justify-center bg-background" style={{ flex: 1, minHeight: 0 }}>
      <div className="text-center">
        <div className="mx-auto mb-6 h-14 w-14 animate-spin rounded-full border-4 border-surface border-t-brand" />
        <p className="text-base text-text-muted">{t("loading")}</p>
      </div>
    </div>
  );

  const wrappedRoutes = <Suspense fallback={lazyFallback}>{routes}</Suspense>;

  if (isElectron()) {
    return (
      <div className="electron-app-wrapper">
        <CustomTitleBar />
        <UpdateBanner />
        {wrappedRoutes}
      </div>
    );
  }

  return (
    <>
      <UpdateBanner />
      {wrappedRoutes}
    </>
  );
}

export default App;
