/**
 * electron/ipc-handlers.ts — Centralized IPC channel registration.
 *
 * Single responsibility: register every renderer→main IPC handler in one
 * place. Each handler is a thin adapter that calls into a domain module
 * (audio-capture, push-to-talk, credentials, settings, …) — no business
 * logic lives here.
 *
 * Splitting the registration this way keeps the IPC contract auditable
 * (one file lists every channel) while keeping domain modules
 * IPC-agnostic and unit-testable.
 */

import { app, clipboard, ipcMain, nativeImage, screen } from "electron";
import { autoUpdater } from "electron-updater";
import { startCapture, stopCapture } from "./audio-capture";
import { consumeLastCrash } from "./crash-reporter";
import { clearCredentials, loadCredentials, saveCredentials } from "./credentials";
import { registerPTT, unregisterPTT } from "./push-to-talk";
import { getSerializedSources } from "./screen-picker";
import { DEFAULT_APP_SETTINGS, getSettings, setSetting } from "./settings";
import { setTrayTooltip } from "./tray";
import { wasPrelaunchChecked } from "./auto-updater";
import { getMainWindow } from "./window";

export function registerIpcHandlers(): void {
  // ─── App / version ──────────────────────────────────────────────
  ipcMain.handle("get-version", () => app.getVersion());
  ipcMain.handle("relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  // ─── Crash report flush ──────────────────────────────────────────
  // Renderer calls this after a successful login. Returns the persisted
  // crash record (if any) and deletes it so the next launch doesn't
  // double-report. Null means "no crash since last call".
  ipcMain.handle("consume-last-crash", () => consumeLastCrash());

  // ─── Auto-updater (renderer-driven) ─────────────────────────────
  ipcMain.handle("was-update-checked", () => wasPrelaunchChecked());

  ipcMain.handle("check-update", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo ?? null;
    } catch {
      return null;
    }
  });

  ipcMain.handle("download-update", async () => {
    try {
      await autoUpdater.downloadUpdate();
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("install-update", () => {
    // isSilent=true (no installer UI), isForceRunAfter=true (auto-restart)
    autoUpdater.quitAndInstall(true, true);
  });

  // ─── Desktop capturer (legacy enumeration, separate from picker) ─
  ipcMain.handle("get-desktop-sources", async () => {
    return await getSerializedSources();
  });

  // ─── Display metrics for the monitor the main window is currently on ─
  // Used by the renderer's `useDisplayInfo` hook to expose a dynamic
  // "Max" option in the screen-share quality + FPS dropdowns. The "Max"
  // option resolves to these values at publish time. We use
  // `getDisplayMatching(window.bounds)` (not `getPrimaryDisplay()`) so
  // users on multi-monitor setups get the metrics of the screen they're
  // actively looking at — moving HiChat! to their 4K secondary picks
  // that monitor's resolution automatically.
  //
  // `bounds`/`size` from Electron are DPI-divided ("logical") pixels.
  // We multiply by scaleFactor to get the physical pixel count the
  // capturer actually publishes, so the "Max" label matches what
  // viewers will see.
  ipcMain.handle("get-display-info", () => {
    const win = getMainWindow();
    const display = win
      ? screen.getDisplayMatching(win.getBounds())
      : screen.getPrimaryDisplay();

    return {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
      refreshRate: display.displayFrequency, // 0 on platforms that don't report it
      scaleFactor: display.scaleFactor,
      monitorCount: screen.getAllDisplays().length,
    };
  });

  // ─── Process-exclusive system audio ──────────────────────────────
  ipcMain.handle("start-system-capture", () => startCapture());
  ipcMain.handle("stop-system-capture", () => stopCapture());

  // ─── Taskbar overlay icon (Windows unread badge) ─────────────────
  ipcMain.handle(
    "set-badge-count",
    (_e: Electron.IpcMainInvokeEvent, count: number, iconDataURL: string | null) => {
      const win = getMainWindow();
      if (!win) return;
      if (count === 0 || !iconDataURL) {
        win.setOverlayIcon(null, "");
      } else {
        win.setOverlayIcon(nativeImage.createFromDataURL(iconDataURL), `${count} unread`);
      }
      setTrayTooltip(count > 0 ? `HiChat! (${count})` : "HiChat!");
    },
  );

  ipcMain.handle("flash-frame", () => {
    const win = getMainWindow();
    if (win && !win.isFocused()) win.flashFrame(true);
  });

  // ─── Custom titlebar window controls ─────────────────────────────
  ipcMain.handle("minimize-window", () => getMainWindow()?.minimize());
  ipcMain.handle("maximize-window", () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("close-window", () => getMainWindow()?.close());

  // ─── Clipboard (sandbox-safe path via main process) ──────────────
  ipcMain.handle("write-clipboard", (_e, text: string) => clipboard.writeText(text));

  // ─── App settings (general / windows) ────────────────────────────
  ipcMain.handle("get-app-settings", () => {
    // Reflect actual OS state — user may have toggled openAtLogin via
    // Windows registry / Settings outside the app.
    const live = app.getLoginItemSettings();
    const cached = getSettings();
    cached.openAtLogin = live.openAtLogin;
    return cached;
  });

  ipcMain.handle("set-app-setting", (_e, key: string, value: boolean) => {
    if (!(key in DEFAULT_APP_SETTINGS)) return;
    setSetting(key, value);
    if (key === "openAtLogin") {
      app.setLoginItemSettings({ openAtLogin: value });
    }
  });

  // ─── Credentials (Remember Me, DPAPI/Keychain encrypted) ─────────
  ipcMain.handle("save-credentials", (_e, username: string, password: string) =>
    saveCredentials(username, password),
  );
  ipcMain.handle("load-credentials", () => loadCredentials());
  ipcMain.handle("clear-credentials", () => clearCredentials());

  // ─── Push-to-Talk shortcuts (uIOhook global keyboard) ────────────
  ipcMain.handle("register-ptt-shortcut", (_e, keyCode: string) => registerPTT(keyCode));
  ipcMain.handle("unregister-ptt-shortcut", () => unregisterPTT());
}
