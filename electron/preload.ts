/**
 * electron/preload.ts — Electron preload script.
 *
 * Exposes a safe API to the renderer process via contextBridge.
 * Accessible in renderer as window.electronAPI.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { GameJoinContext, GameJoinContextAck, CS2JoinRequest, CS2JoinStatus } from "./cs2-join-controller";
import type {
  PublicRegisteredGame as ElectronRegisteredGame,
  RegisteredGameActivity as ElectronRegisteredGameActivity,
  RegisteredGamesSnapshot as ElectronRegisteredGamesSnapshot,
} from "./registered-games";

// Keep runtime helpers inside this file: sandboxed preloads cannot require
// arbitrary local modules. Each disposer owns only its registered listener.
function subscribeIPC<T>(channel: string, callback: (value: T) => void): () => void {
  let active = true;
  const listener = (_event: unknown, value: T) => { if (active) callback(value); };
  ipcRenderer.on(channel, listener);
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("electronAPI", {
  syncGameJoinContext: (context: GameJoinContext | null): Promise<GameJoinContextAck> => ipcRenderer.invoke("sync-game-join-context", context),
  launchCS2GameJoin: (request: CS2JoinRequest): Promise<CS2JoinStatus> => ipcRenderer.invoke("launch-cs2-game-join", request),
  setRegisteredGameJoinAdapter: (id: string, adapter: "none" | "cs2-steam"): Promise<boolean> => ipcRenderer.invoke("set-registered-game-join-adapter", id, adapter),
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

  /**
   * Append a structured entry to the always-on local diagnostic log
   * (electron/diagnostic-log.ts). Fire-and-forget — the renderer tees every
   * logToServer event here so it survives offline / pre-login / WS-down / crash.
   */
  appendDiagnostic: (entry: {
    level?: "info" | "warn" | "error";
    msg: string;
    category?: string;
    meta?: Record<string, unknown>;
  }): void => {
    ipcRenderer.send("diagnostic-log", entry);
  },

  /** Build the gzipped diagnostics bundle bytes (uploaded via the feedback API). */
  buildDiagnosticUpload: (): Promise<{ filename: string; data: Uint8Array }> =>
    ipcRenderer.invoke("build-diagnostic-upload"),

  /** Save the diagnostics bundle to a user-chosen file (native save dialog). */
  exportDiagnostics: (): Promise<{ saved: boolean; path?: string; dumpCopied?: boolean }> =>
    ipcRenderer.invoke("export-diagnostics"),

  /** Open the folder containing the rolling diagnostic logs. */
  openLogsDir: (): Promise<string> => ipcRenderer.invoke("open-logs-dir"),

  /** Read whether verbose diagnostic logging is enabled. */
  getDiagnosticVerbose: (): Promise<boolean> => ipcRenderer.invoke("get-diagnostic-verbose"),

  /** Enable/disable verbose diagnostic logging (persisted). */
  setDiagnosticVerbose: (value: boolean): Promise<void> =>
    ipcRenderer.invoke("set-diagnostic-verbose", value),

  capturePerformanceTrace: (): Promise<{ saved: boolean; cancelled: boolean; path?: string }> =>
    ipcRenderer.invoke("capture-performance-trace"),
  cancelPerformanceTrace: (): Promise<boolean> => ipcRenderer.invoke("cancel-performance-trace"),

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

  /** Local Windows game registry; executable paths stay in the main process. */
  getRegisteredGames: (): Promise<ElectronRegisteredGamesSnapshot> =>
    ipcRenderer.invoke("get-registered-games"),
  getRegisteredGameActivity: (): Promise<ElectronRegisteredGameActivity> =>
    ipcRenderer.invoke("get-registered-game-activity"),
  setRegisteredGamesBackgroundDetection: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("set-registered-games-background-detection", enabled),
  addRegisteredGame: (): Promise<ElectronRegisteredGame | null> =>
    ipcRenderer.invoke("add-registered-game"),
  removeRegisteredGame: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("remove-registered-game", id),
  setRegisteredGameName: (id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke("set-registered-game-name", id, name),
  setRegisteredGameSharing: (id: string, allowed: boolean): Promise<boolean> =>
    ipcRenderer.invoke("set-registered-game-sharing", id, allowed),
  setRegisteredGameOverlay: (id: string, allowed: boolean): Promise<boolean> =>
    ipcRenderer.invoke("set-registered-game-overlay", id, allowed),

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

  /**
   * Subscribe to diagnostic events emitted by the main-process screen picker.
   * Each event carries a phase string (request_handler_start, sources_query_*,
   * picker_shown, result_received, handler_error, etc.) plus arbitrary
   * extras. The renderer is expected to forward these to /client-log so the
   * admin panel can correlate a "screen_share_attempt" row against the
   * main-process picker timeline. Idempotent registration is the caller's
   * job — install once at module load.
   */
  onScreenPickerDiagnostic: (
    cb: (event: { phase: string; timestamp: number } & Record<string, unknown>) => void,
  ): void => {
    ipcRenderer.on("screen-picker-diagnostic", (_e, payload) => cb(payload));
  },

  // ─── Process-Exclusive Audio Capture IPC ───
  // Uses native audio-capture.exe (WASAPI process loopback) to capture
  // system audio while excluding our own process tree — no voice echo.

  reserveSystemCaptureLease:(request:{kind:"guild"|"p2p"|"group";source:string}):Promise<string>=>ipcRenderer.invoke("reserve-system-capture-lease",request),
  startSystemCaptureLease:(id:string):Promise<void>=>ipcRenderer.invoke("start-system-capture-lease",id),
  releaseSystemCaptureLease:(id:string):Promise<boolean>=>ipcRenderer.invoke("release-system-capture-lease",id),
  onSystemCaptureLeaseEvent:(cb:(event:{leaseId:string;type:"header"|"data"|"error"|"stopped";value?:unknown})=>void):(()=>void)=>{
    const listener=(_event:Electron.IpcRendererEvent,event:{leaseId:string;type:"header"|"data"|"error"|"stopped";value?:unknown})=>cb(event);
    ipcRenderer.on("system-capture-lease-event",listener);return()=>ipcRenderer.removeListener("system-capture-lease-event",listener);
  },

  /** Start system audio capture (excludes Electron's own audio) */
  startSystemCapture: (): Promise<void> => ipcRenderer.invoke("start-system-capture"),

  /** Stop system audio capture */
  stopSystemCapture: (): Promise<void> => ipcRenderer.invoke("stop-system-capture"),

  /** Read lifecycle state without subscribing to or receiving PCM data. */
  getSystemCaptureStatus: (): Promise<{ state: "unavailable" | "stopped" | "starting" | "running" | "error"; reason?: string; owner?: "screen_share" | "diagnostic" }> =>
    ipcRenderer.invoke("get-system-capture-status"),

  /** Opt-in diagnostics run only while screen-share capture is idle; returns its stop token. */
  startSystemCaptureDiagnostic: (): Promise<string> => ipcRenderer.invoke("start-system-capture-diagnostic"),

  /** Stops only the diagnostic capture run created by this renderer. */
  stopSystemCaptureDiagnostic: (token: string): Promise<boolean> => ipcRenderer.invoke("stop-system-capture-diagnostic", token),

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

  acquirePTTLease: (request: {kind:"guild"|"p2p"|"group";source:string;keyCode:string}):Promise<string|null> => ipcRenderer.invoke("acquire-ptt-lease",request),
  releasePTTLease: (id:string):Promise<void> => ipcRenderer.invoke("release-ptt-lease",id),
  onPTTLeaseSignal: (cb:(signal:{leaseId:string;pressed:boolean})=>void):(()=>void) => {
    const listener=(_event:Electron.IpcRendererEvent,signal:{leaseId:string;pressed:boolean})=>cb(signal);
    ipcRenderer.on("ptt-lease-signal",listener);
    return ()=>ipcRenderer.removeListener("ptt-lease-signal",listener);
  },

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

  // ─── Global Mute Hotkey Shortcut ───
  // Mirrors the Global PTT block above — shares the same uIOhook hook
  // (electron/push-to-talk.ts) but latches instead of firing down/up pairs.

  /** Register a key for the global mute-toggle hotkey (works even when app is unfocused) */
  registerMuteHotkeyShortcut: (keyCode: string): Promise<boolean> =>
    ipcRenderer.invoke("register-mute-hotkey-shortcut", keyCode),

  /** Unregister the global mute-toggle hotkey */
  unregisterMuteHotkeyShortcut: (): Promise<void> =>
    ipcRenderer.invoke("unregister-mute-hotkey-shortcut"),

  /** Mute hotkey pressed globally (main → renderer) */
  onMuteHotkeyGlobal: (cb: () => void): void => {
    ipcRenderer.on("mute-hotkey-global", () => cb());
  },

  /** Remove global mute hotkey listeners to prevent accumulation across sessions */
  removeMuteHotkeyListeners: (): void => {
    ipcRenderer.removeAllListeners("mute-hotkey-global");
  },

  // ─── Credential Storage (Remember Me) ───

  /** Save credentials encrypted via safeStorage */
  saveCredentials: (username: string, password: string): Promise<void> =>
    ipcRenderer.invoke("save-credentials", username, password),

  /**
   * Load the saved username (null if none). The password is deliberately not
   * part of this — see loginWithSavedCredentials (pentest 2026-07-26, H-09).
   */
  loadCredentials: (): Promise<{ username: string } | null> =>
    ipcRenderer.invoke("load-credentials"),

  /**
   * Log in with the stored password, performed in the main process so the
   * password never enters the renderer. Resolves to the upstream login
   * response; rejects when nothing is stored.
   */
  loginWithSavedCredentials: (
    upstreamOrigin: string,
  ): Promise<{ status: number; body: unknown }> =>
    ipcRenderer.invoke("login-with-saved-credentials", upstreamOrigin),

  /** Clear saved credentials */
  clearCredentials: (): Promise<void> =>
    ipcRenderer.invoke("clear-credentials"),

  // ─── App Settings (General / Windows Settings) ───

  /** Read all app settings */
  getAppSettings: (): Promise<{ openAtLogin: boolean; startMinimized: boolean; closeToTray: boolean; transparentBackground: boolean; hardwareAcceleration: boolean }> =>
    ipcRenderer.invoke("get-app-settings"),

  /** Update a single app setting */
  setAppSetting: (key: string, value: boolean): Promise<void> =>
    ipcRenderer.invoke("set-app-setting", key, value),
  onVoiceOverlayUpdate: (cb: (snapshot: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown) => cb(snapshot);
    ipcRenderer.on("voice-overlay-update", listener);
    return () => { ipcRenderer.removeListener("voice-overlay-update", listener); };
  },
  sendVoiceOverlaySnapshot: (snapshot: unknown): Promise<boolean> => ipcRenderer.invoke("voice-overlay-snapshot", snapshot),
  clearOverlayGameNotices: (): Promise<void> => ipcRenderer.invoke("clear-overlay-game-notices"),
  openOverlayMediaLease: (lease: unknown): Promise<boolean> => ipcRenderer.invoke("open-overlay-media-lease", lease),
  sendOverlayMedia: (envelope: unknown): Promise<boolean> => ipcRenderer.invoke("send-overlay-media", envelope),
  sendOverlayMediaViewport: (viewport: unknown): Promise<boolean> => ipcRenderer.invoke("send-overlay-media-viewport", viewport),
  setOverlayMediaReceiverReady: (ready: boolean): Promise<boolean> => ipcRenderer.invoke("set-overlay-media-receiver-ready", ready),
  getOverlayMediaAvailability: (): Promise<unknown> => ipcRenderer.invoke("get-overlay-media-availability"),
  onOverlayMedia: (callback: (value: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
    ipcRenderer.on("overlay-media", listener); return () => ipcRenderer.removeListener("overlay-media", listener);
  },
  onOverlayMediaLease: (callback: (value: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
    ipcRenderer.on("overlay-media-lease", listener); return () => ipcRenderer.removeListener("overlay-media-lease", listener);
  },
  onOverlayMediaViewport: (callback: (value: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
    ipcRenderer.on("overlay-media-viewport", listener); return () => ipcRenderer.removeListener("overlay-media-viewport", listener);
  },
  onOverlayMediaAvailability: (callback: (value: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
    ipcRenderer.on("overlay-media-availability", listener); return () => ipcRenderer.removeListener("overlay-media-availability", listener);
  },
  setOverlayShortcut: (binding: unknown): Promise<boolean> => ipcRenderer.invoke("set-overlay-shortcut", binding),
  resetOverlayLayout: (): Promise<boolean> => ipcRenderer.invoke("reset-overlay-layout"),
  sendOverlayVoiceAction: (action: unknown, session: unknown): Promise<boolean> => ipcRenderer.invoke("overlay-voice-action", action, session),
  sendOverlayOpenInbox: (session: unknown): Promise<boolean> => ipcRenderer.invoke("overlay-open-inbox", session),
  confirmOverlayOpenInbox: (session: unknown): Promise<boolean> => ipcRenderer.invoke("confirm-overlay-open-inbox", session),
  onOverlayOpenInbox: (callback: (value: { session: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { session: string }) => callback(value);
    ipcRenderer.on("overlay-open-inbox", listener);
    return () => ipcRenderer.removeListener("overlay-open-inbox", listener);
  },
  sendOverlayPrepareNotificationReply: (request: unknown): Promise<boolean> => ipcRenderer.invoke("overlay-prepare-notification-reply", request),
  confirmOverlayPrepareNotificationReply: (request: unknown): Promise<boolean> => ipcRenderer.invoke("confirm-overlay-prepare-notification-reply", request),
  onOverlayPrepareNotificationReply: (callback: (value: { session: string; notificationId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { session: string; notificationId: string }) => callback(value);
    ipcRenderer.on("overlay-prepare-notification-reply", listener);
    return () => ipcRenderer.removeListener("overlay-prepare-notification-reply", listener);
  },
  sendOverlayOpenChat: (session: unknown): Promise<boolean> => ipcRenderer.invoke("overlay-open-chat", session),
  confirmOverlayOpenChat: (session: unknown): Promise<boolean> => ipcRenderer.invoke("confirm-overlay-open-chat", session),
  onOverlayOpenChat: (callback: (value: { session: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { session: string }) => callback(value);
    ipcRenderer.on("overlay-open-chat", listener);
    return () => ipcRenderer.removeListener("overlay-open-chat", listener);
  },
  sendOverlayOpenChatComposer: (session: unknown): Promise<boolean> => ipcRenderer.invoke("overlay-open-chat-composer", session),
  sendOverlayChatMessage: (request: unknown): Promise<"sent" | "failed" | "unavailable"> => ipcRenderer.invoke("overlay-chat-send", request),
  closeOverlayChatComposer: (session: unknown): Promise<boolean> => ipcRenderer.invoke("close-overlay-chat-composer", session),
  onOverlayChatSend: (callback: (value: { session: string; requestId: string; text: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { session: string; requestId: string; text: string }) => callback(value);
    ipcRenderer.on("overlay-chat-send", listener);
    return () => ipcRenderer.removeListener("overlay-chat-send", listener);
  },
  resolveOverlayChatSend: (request: unknown): Promise<boolean> => ipcRenderer.invoke("resolve-overlay-chat-send", request),
  onOverlayChatComposerClosed: (callback: (value: { session: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { session: string }) => callback(value);
    ipcRenderer.on("overlay-chat-composer-closed", listener);
    return () => ipcRenderer.removeListener("overlay-chat-composer-closed", listener);
  },
  onOverlayVoiceAction: (callback: (value: { action: "toggle-mute" | "toggle-deafen"; session: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { action: "toggle-mute" | "toggle-deafen"; session: string }) => callback(value);
    ipcRenderer.on("overlay-voice-action", listener);
    return () => ipcRenderer.removeListener("overlay-voice-action", listener);
  },

  // ─── Window Controls (Custom Titlebar) ───

  /** Minimize window */
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke("minimize-window"),

  /** Toggle maximize / restore */
  maximizeWindow: (): Promise<void> => ipcRenderer.invoke("maximize-window"),

  /** Close window (respects close-to-tray) */
  closeWindow: (): Promise<void> => ipcRenderer.invoke("close-window"),

  /** Listen for maximize/unmaximize changes (icon toggle) */
  onMaximizedChange: (cb: (isMaximized: boolean) => void): (() => void) =>
    subscribeIPC("window-maximized-change", cb),

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
  onUpdateAvailable: (cb: (info: unknown) => void): (() => void) =>
    subscribeIPC("update-available", cb),

  /** Download progress */
  onUpdateProgress: (cb: (progress: unknown) => void): (() => void) =>
    subscribeIPC("update-progress", cb),

  /** Download completed — info carries `{ version, releaseNotes?, ... }` */
  onUpdateDownloaded: (cb: (info: { version: string }) => void): (() => void) =>
    subscribeIPC("update-downloaded", cb),

  /** Update error */
  onUpdateError: (cb: (message: string) => void): (() => void) =>
    subscribeIPC("update-error", cb),
});
