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

import { app, clipboard, ipcMain, nativeImage } from "electron";
import { autoUpdater } from "electron-updater";
import { startCapture, stopCapture } from "./audio-capture";
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
