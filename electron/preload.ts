/**
 * electron/preload.ts — Electron preload script.
 *
 * Exposes a safe API to the renderer process via contextBridge.
 * Accessible in renderer as window.electronAPI.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // ─── Invoke-style IPC (renderer → main → response) ───

  /** App version from package.json */
  getVersion: (): Promise<string> => ipcRenderer.invoke("get-version"),

  /** Relaunch the app — used by ConnectionSettings */
  relaunch: (): Promise<void> => ipcRenderer.invoke("relaunch"),

  /**
   * Read the persisted crash record (if any) from the previous launch and
   * delete it. Returns null when there's nothing to report. The renderer
   * calls this once after a successful login and forwards the record to
   * /api/client-log so it lands in the admin panel.
   */
  consumeLastCrash: (): Promise<{
    kind: "render-process-gone" | "child-process-gone";
    reason: string;
    exitCode?: number;
    serviceName?: string;
    processType?: string;
    occurredAt: string;
    dumpFile?: string;
  } | null> => ipcRenderer.invoke("consume-last-crash"),

  /** Whether pre-launch update check ran — prevents duplicate checks in renderer */
  wasUpdateChecked: (): Promise<boolean> => ipcRenderer.invoke("was-update-checked"),

  /** Check for updates — returns UpdateInfo or null */
  checkUpdate: (): Promise<unknown> => ipcRenderer.invoke("check-update"),

  /** Download the update */
  downloadUpdate: (): Promise<boolean> => ipcRenderer.invoke("download-update"),

  /** Install update and restart */
  installUpdate: (): Promise<void> => ipcRenderer.invoke("install-update"),

  /** List available screen/window sources for screen sharing */
  getDesktopSources: (): Promise<
    Array<{ id: string; name: string; thumbnail: string }>
  > => ipcRenderer.invoke("get-desktop-sources"),

  /**
   * Physical-pixel metrics of the monitor the main window currently lives on.
   * Used by `useDisplayInfo` to expose dynamic "Max" options in the
   * screen-share quality + FPS dropdowns. `refreshRate` is 0 on platforms
   * that don't report it (some Linux X11 configurations).
   */
  getDisplayInfo: (): Promise<{
    width: number;
    height: number;
    refreshRate: number;
    scaleFactor: number;
    monitorCount: number;
  }> => ipcRenderer.invoke("get-display-info"),

  // ─── Screen Picker IPC ───

  /**
   * Main process requests screen picker — receives sources. `appIcon` is the
   * window's owner-app icon as a DataURL (or null if not available — e.g.
   * for "screen" sources or apps without an icon resource).
   */
  onShowScreenPicker: (
    cb: (
      sources: Array<{
        id: string;
        name: string;
        thumbnail: string;
        appIcon: string | null;
      }>,
    ) => void,
  ): void => {
    ipcRenderer.on("show-screen-picker", (_e, sources) => cb(sources));
  },

  /**
   * Re-query desktop sources while the picker is open. Lets the user pick up
   * a window that started or became visible after the picker first appeared
   * (the most common reason a target window is "missing" from the list).
   */
  refreshScreenPickerSources: (): void => {
    ipcRenderer.send("screen-picker-refresh");
  },

  /** Result from a refreshScreenPickerSources() call. */
  onScreenPickerRefreshResult: (
    cb: (
      sources: Array<{
        id: string;
        name: string;
        thumbnail: string;
        appIcon: string | null;
      }>,
    ) => void,
  ): void => {
    ipcRenderer.on("screen-picker-refresh-result", (_e, sources) => cb(sources));
  },

  /** Remove the refresh-result listener (on picker close). */
  removeScreenPickerRefreshListener: (): void => {
    ipcRenderer.removeAllListeners("screen-picker-refresh-result");
  },

  /** Send user's selection to main process (null = cancelled) */
  sendScreenPickerResult: (sourceId: string | null): void => {
    ipcRenderer.send("screen-picker-result", sourceId);
  },

  // ─── Process-Exclusive Audio Capture IPC ───
  // Uses native audio-capture.exe (WASAPI process loopback) to capture
  // system audio while excluding our own process tree — no voice echo.

  /** Start system audio capture (excludes Electron's own audio) */
  startSystemCapture: (): Promise<void> => ipcRenderer.invoke("start-system-capture"),

  /** Stop system audio capture */
  stopSystemCapture: (): Promise<void> => ipcRenderer.invoke("stop-system-capture"),

  /**
   * Remove all capture-related IPC listeners.
   * MUST be called before registering new listeners in start() and during stop().
   * Without this, ipcRenderer.on() accumulates duplicate listeners across
   * screen share sessions — old listeners intercept events meant for new sessions.
   */
  removeCaptureListeners: (): void => {
    ipcRenderer.removeAllListeners("capture-audio-header");
    ipcRenderer.removeAllListeners("capture-audio-data");
    ipcRenderer.removeAllListeners("capture-audio-stopped");
    ipcRenderer.removeAllListeners("capture-audio-error");
  },

  /** Audio capture header received (format info) */
  onCaptureAudioHeader: (
    cb: (header: { sampleRate: number; channels: number; bitsPerSample: number; formatTag: number }) => void
  ): void => {
    ipcRenderer.on("capture-audio-header", (_e, header) => cb(header));
  },

  /** Raw PCM audio data chunk from capture process */
  onCaptureAudioData: (cb: (data: Uint8Array) => void): void => {
    ipcRenderer.on("capture-audio-data", (_e, data) => cb(new Uint8Array(data)));
  },

  /** Audio capture process stopped (exited or error) */
  onCaptureAudioStopped: (cb: () => void): void => {
    ipcRenderer.on("capture-audio-stopped", () => cb());
  },

  /** Audio capture error/debug message from main process */
  onCaptureAudioError: (cb: (msg: string) => void): void => {
    ipcRenderer.on("capture-audio-error", (_e, msg) => cb(msg));
  },

  // ─── Global PTT (Push-to-Talk) Shortcut ───

  /** Register a key for global PTT detection (works even when app is unfocused) */
  registerPTTShortcut: (keyCode: string): Promise<boolean> =>
    ipcRenderer.invoke("register-ptt-shortcut", keyCode),

  /** Unregister the global PTT shortcut */
  unregisterPTTShortcut: (): Promise<void> =>
    ipcRenderer.invoke("unregister-ptt-shortcut"),

  /** PTT key pressed globally (main → renderer) */
  onPTTGlobalDown: (cb: () => void): void => {
    ipcRenderer.on("ptt-global-down", () => cb());
  },

  /** PTT key released globally (main → renderer) */
  onPTTGlobalUp: (cb: () => void): void => {
    ipcRenderer.on("ptt-global-up", () => cb());
  },

  /** Remove global PTT listeners to prevent accumulation across sessions */
  removePTTListeners: (): void => {
    ipcRenderer.removeAllListeners("ptt-global-down");
    ipcRenderer.removeAllListeners("ptt-global-up");
  },

  // ─── Credential Storage (Remember Me) ───

  /** Save credentials encrypted via safeStorage */
  saveCredentials: (username: string, password: string): Promise<void> =>
    ipcRenderer.invoke("save-credentials", username, password),

  /** Load saved credentials (null if none) */
  loadCredentials: (): Promise<{ username: string; password: string } | null> =>
    ipcRenderer.invoke("load-credentials"),

  /** Clear saved credentials */
  clearCredentials: (): Promise<void> =>
    ipcRenderer.invoke("clear-credentials"),

  // ─── App Settings (General / Windows Settings) ───

  /** Read all app settings */
  getAppSettings: (): Promise<{ openAtLogin: boolean; startMinimized: boolean; closeToTray: boolean; transparentBackground: boolean }> =>
    ipcRenderer.invoke("get-app-settings"),

  /** Update a single app setting */
  setAppSetting: (key: string, value: boolean): Promise<void> =>
    ipcRenderer.invoke("set-app-setting", key, value),

  // ─── Window Controls (Custom Titlebar) ───

  /** Minimize window */
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke("minimize-window"),

  /** Toggle maximize / restore */
  maximizeWindow: (): Promise<void> => ipcRenderer.invoke("maximize-window"),

  /** Close window (respects close-to-tray) */
  closeWindow: (): Promise<void> => ipcRenderer.invoke("close-window"),

  /** Listen for maximize/unmaximize changes (icon toggle) */
  onMaximizedChange: (cb: (isMaximized: boolean) => void): void => {
    ipcRenderer.on("window-maximized-change", (_e, val) => cb(val));
  },

  /** Remove maximize listener (on component unmount) */
  removeMaximizedListener: (): void => {
    ipcRenderer.removeAllListeners("window-maximized-change");
  },

  // ─── Taskbar Badge + Flash ───

  /** Set taskbar overlay badge icon (Windows). count=0 removes badge. */
  setBadgeCount: (count: number, iconDataURL: string | null): Promise<void> =>
    ipcRenderer.invoke("set-badge-count", count, iconDataURL),

  /** Flash taskbar icon to attract attention on new messages/calls */
  flashFrame: (): Promise<void> => ipcRenderer.invoke("flash-frame"),

  // ─── Clipboard ───

  /** Copy text to clipboard via main process IPC */
  writeClipboard: (text: string): Promise<void> =>
    ipcRenderer.invoke("write-clipboard", text),

  // ─── Event listeners (main → renderer) ───

  /** Update available */
  onUpdateAvailable: (cb: (info: unknown) => void): void => {
    ipcRenderer.on("update-available", (_e, info) => cb(info));
  },

  /** Download progress */
  onUpdateProgress: (cb: (progress: unknown) => void): void => {
    ipcRenderer.on("update-progress", (_e, progress) => cb(progress));
  },

  /** Download completed — info carries `{ version, releaseNotes?, ... }` */
  onUpdateDownloaded: (cb: (info: { version: string }) => void): void => {
    ipcRenderer.on("update-downloaded", (_e, info) => cb(info));
  },

  /** Update error */
  onUpdateError: (cb: (message: string) => void): void => {
    ipcRenderer.on("update-error", (_e, message) => cb(message));
  },
});
