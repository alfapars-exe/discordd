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

/** Auto-grant the media + display-capture + fullscreen permissions we always need. */
function setupPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_w, permission, callback) => {
    const allowed = ["media", "display-capture", "mediaKeySystem", "fullscreen"];
    callback(allowed.includes(permission));
  });
}

// ─── App ready ───
app.whenReady().then(async () => {
  setupPermissions();
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
