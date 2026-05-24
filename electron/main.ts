/**
 * electron/main.ts — Electron main process entry point.
 *
 * Single responsibility: orchestrate the app lifecycle.
 * Domain logic lives in dedicated modules:
 *   - settings.ts       — persisted app settings
 *   - window.ts         — main BrowserWindow + bounds
 *   - tray.ts           — system tray icon + menu
 *   - auto-updater.ts   — pre-launch splash + electron-updater
 *   - audio-capture.ts  — process-exclusive WASAPI loopback
 *   - push-to-talk.ts   — global keyboard PTT via uIOhook
 *   - screen-picker.ts  — getDisplayMedia interception + custom picker
 *   - credentials.ts    — DPAPI/Keychain "Remember Me" storage
 *   - ipc-handlers.ts   — every renderer↔main IPC channel
 *
 * Each module owns its own state and exposes a small public API.
 * This file should stay short — additions here are a smell that a
 * new module is needed instead.
 */

import { app, BrowserWindow, session } from "electron";
import { checkForUpdateBeforeLaunch, setupAutoUpdater } from "./auto-updater";
import { shutdownCapture } from "./audio-capture";
import { registerIpcHandlers } from "./ipc-handlers";
import { installScreenPicker } from "./screen-picker";
import { shutdownPTT } from "./push-to-talk";
import { createTray } from "./tray";
import { createMainWindow, getMainWindow, setQuitting } from "./window";

// ─── Chromium feature switches ───
//
// Track M (v2.11.41) enabled Windows Graphics Capture (WGC) for screen sharing
// so DirectX/Vulkan fullscreen games and admin-elevated process windows would
// render correctly. Track P (this commit) reverts that opt-in because WGC
// bypasses Chromium's `MediaTrackConstraints.cursor` pipeline — the user-
// facing "Show cursor in screen share" toggle in Voice Settings was a no-op
// under WGC since the WGC capturer always composites the system cursor on
// every frame.
//
// Cursor toggle is higher priority than fullscreen-game thumbnails for this
// app's audience (community voice calls, screen-share onboarding sessions),
// so we accept the trade-off:
//   - DirectX/Vulkan exclusive-fullscreen titles may show a black/frozen
//     thumbnail in the picker. Most still stream once selected because the
//     GDI fallback handles their composited backbuffer; titles with HW overlay
//     (some Riot Vanguard / EAC builds) won't capture cleanly either way.
//   - Admin-elevated app windows still appear because Track M's
//     `requireAdministrator` manifest stays — integrity-level bypass is
//     orthogonal to the capture backend.
//
// If we ever need WGC back without losing cursor control, the path forward
// is upstream Chromium: a `--disable-features=WgcCursorCapture` flag or a
// new Electron API surface on `setDisplayMediaRequestHandler`. Neither
// exists today.

// ─── App identity ───
// Sets every "what's the app called?" surface inside Electron — the about
// panel, native notification group, %APPDATA% path segment (HiChat!), and
// (on Windows) the taskbar grouping AppUserModelID. Must run before any
// app.getPath() / app.requestSingleInstanceLock() / window creation.
app.setName("HiChat!");
if (process.platform === "win32") {
  // Match package.json build.appId so taskbar and Action Center associate
  // notifications with this app rather than the generic "Electron" host.
  app.setAppUserModelId("net.hichat.app");
}

// ─── Single-instance lock ───
// Second launch of HiChat! brings the existing window forward instead of
// starting a duplicate process — required for tray + global PTT to work
// reliably (otherwise each instance fights for the uIOhook subscription).
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
} else {
  app.quit();
}

/**
 * Auto-grant media/display-capture/fullscreen permissions, but only for
 * the renderer's legitimate origins. The earlier handler granted to ANY
 * origin — a stored XSS that loaded a remote iframe could then quietly
 * open the user's webcam/mic.
 *
 * Allowed:
 *   - file:// — production bundle loaded via loadFile().
 *   - http://localhost:3030 — Vite dev server in electron:dev.
 *   - https://hichat.app / https://mqvi.net — official web origins, for
 *     the rare case we point the desktop wrapper at the SaaS instance.
 *
 * Any other origin (data:, javascript:, untrusted https) is rejected.
 */
function setupPermissions(): void {
  const allowedPermissions = ["media", "display-capture", "mediaKeySystem", "fullscreen"];
  const allowedOriginPrefixes = [
    "file://",
    "http://localhost:3030",
    "https://hichat.app",
    "https://mqvi.net",
  ];

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (!allowedPermissions.includes(permission)) {
      callback(false);
      return;
    }
    const url = webContents.getURL();
    const allowed = allowedOriginPrefixes.some((p) => url.startsWith(p));
    if (!allowed) {
      console.warn(`[permissions] denied ${permission} for origin: ${url}`);
    }
    callback(allowed);
  });
}

/**
 * Inject a Content Security Policy into every renderer response.
 *
 * Defense-in-depth against XSS: even if a stored XSS slips past sanitization
 * (display names, message content, link previews), the CSP blocks the
 * attacker from loading external scripts or exfiltrating tokens via
 * cross-origin requests.
 *
 * file: scheme is allowed because the production bundle loads via loadFile.
 * connect-src is broader than the server-side CSP because the desktop app
 * talks to arbitrary user-configured LiveKit endpoints (self-host) plus
 * the central mqvi.net API.
 */
function setupCSP(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp =
      "default-src 'self' file:; " +
      "script-src 'self' file:; " +
      "style-src 'self' 'unsafe-inline' file:; " +
      "img-src 'self' data: blob: file: https:; " +
      "font-src 'self' data: file:; " +
      "media-src 'self' blob: file:; " +
      "connect-src 'self' file: ws: wss: https:; " +
      "worker-src 'self' blob:; " +
      "frame-ancestors 'none'; " +
      "frame-src 'none'; " +
      "object-src 'none'; " +
      "base-uri 'self'";

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
        "X-Content-Type-Options": ["nosniff"],
        "X-Frame-Options": ["DENY"],
        "Referrer-Policy": ["strict-origin-when-cross-origin"],
      },
    });
  });
}

// ─── App ready ───
app.whenReady().then(async () => {
  setupPermissions();
  setupCSP();
  installScreenPicker();

  // Pre-launch splash → check for updates → maybe download + restart
  const updating = await checkForUpdateBeforeLaunch();
  if (updating) return; // quitAndInstall will fire — skip window creation

  registerIpcHandlers();
  setupAutoUpdater();
  createMainWindow();
  createTray();
});

// ─── Platform behaviours ───
app.on("window-all-closed", () => {
  // macOS keeps the app alive in the dock when all windows are closed
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  // macOS: re-create the window when the dock icon is clicked with no windows open
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  } else {
    getMainWindow()?.show();
  }
});

// ─── Graceful shutdown ───
// Wait for the audio capture child process to exit gracefully so Windows
// doesn't force-kill it mid-cleanup (which surfaces a STATUS_BREAKPOINT
// crash dialog). Same idea for stopping the uIOhook listener cleanly.
let shutdownStarted = false;
app.on("before-quit", (e) => {
  setQuitting(true);
  shutdownPTT();

  if (shutdownStarted) return;
  const captureShutdown = shutdownCapture();
  if (!captureShutdown) return; // nothing to wait for

  e.preventDefault();
  shutdownStarted = true;
  captureShutdown.then(() => app.quit());
});
