/**
 * Electron preload API type declarations.
 *
 * Types for contextBridge.exposeInMainWorld("electronAPI", ...) in electron/preload.ts.
 * window.electronAPI is only available in Electron — undefined in browser mode.
 */

interface ElectronUpdateInfo {
  version: string;
  releaseNotes?: string;
  releaseName?: string;
}

interface ElectronDownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

interface ElectronDesktopSource {
  id: string;
  name: string;
  thumbnail: string;
  /**
   * App icon as a data URL — null for "screen" sources or apps without an
   * icon resource. Optional because the legacy `getDesktopSources` IPC
   * path doesn't populate it.
   */
  appIcon?: string | null;
}

/** Audio capture header — format info from native audio-capture.exe */
interface ElectronCaptureAudioHeader {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  formatTag: number; // 1=PCM, 3=IEEE_FLOAT
}

export interface ElectronRegisteredGame {
  id: string;
  displayName: string;
  executableName: string;
  shareAllowed: boolean;
  /** Local opt-in for a voice overlay over this game's foreground window. */
  overlayAllowed: boolean;
  availability: "available" | "missing" | "unreadable";
  /** null when process detection is unavailable; never interpreted as stopped. */
  running: boolean | null;
  lastSeenAt: string | null;
}

export interface ElectronRegisteredGamesSnapshot {
  detection: "available" | "unsupported" | "unavailable";
  /** Helper presence only; available does not imply runtime compatibility. */
  overlaySupport?: "available" | "unavailable" | "unsupported";
  backgroundDetectionEnabled: boolean;
  games: ElectronRegisteredGame[];
}

/** Path-free local activity projection; process detection is never triggered by its getter. */
export interface ElectronRegisteredGameActivity {
  enabled: boolean;
  game: { id: string; name: string } | null;
}

/**
 * Crash record persisted by electron/crash-reporter.ts on render-process-gone
 * or child-process-gone events. Drained by `consumeLastCrash()` on the next
 * launch's first successful login and forwarded to /api/client-log.
 */
interface ElectronCrashRecord {
  kind: "render-process-gone" | "child-process-gone";
  reason: string;
  exitCode?: number;
  serviceName?: string;
  processType?: string;
  occurredAt: string;
  /**
   * Basename of the most recent native .dmp dump (Crashpad/Breakpad) at the
   * time the record was drained. Lets support tell the user which file to
   * zip up from `%APPDATA%/HiChat/Crashpad/` (or the platform equivalent).
   * Empty when no dump existed — common for clean-exit-ish events.
   */
  dumpFile?: string;
}

interface ElectronAPI {
  getVersion: () => Promise<string>;
  relaunch: () => Promise<void>;
  /**
   * Read & clear the persisted crash record (if any) from the previous run.
   * Returns null when there's nothing to report.
   */
  consumeLastCrash: () => Promise<ElectronCrashRecord | null>;

  /**
   * Append a structured entry to the always-on local diagnostic log
   * (electron/diagnostic-log.ts). Fire-and-forget; the renderer tees every
   * logToServer event here so it survives offline / pre-login / WS-down / crash.
   */
  appendDiagnostic: (entry: {
    level?: "info" | "warn" | "error";
    msg: string;
    category?: string;
    meta?: Record<string, unknown>;
  }) => void;

  /** Build the gzipped diagnostics bundle bytes (uploaded via the feedback API). */
  buildDiagnosticUpload: () => Promise<{ filename: string; data: Uint8Array }>;
  /** Save the diagnostics bundle to a user-chosen file (native save dialog). */
  exportDiagnostics: () => Promise<{ saved: boolean; path?: string; dumpCopied?: boolean }>;
  /** Open the folder containing the rolling diagnostic logs. */
  openLogsDir: () => Promise<string>;
  /** Read whether verbose diagnostic logging is enabled. */
  getDiagnosticVerbose: () => Promise<boolean>;
  /** Enable/disable verbose diagnostic logging (persisted). */
  setDiagnosticVerbose: (value: boolean) => Promise<void>;
  capturePerformanceTrace: () => Promise<{ saved: boolean; cancelled: boolean; path?: string }>;
  cancelPerformanceTrace: () => Promise<boolean>;

  /** Whether update check was already performed at splash */
  wasUpdateChecked: () => Promise<boolean>;
  checkUpdate: () => Promise<ElectronUpdateInfo | null>;
  downloadUpdate: () => Promise<boolean>;
  installUpdate: () => Promise<void>;

  getDesktopSources: () => Promise<ElectronDesktopSource[]>;

  /**
   * Physical-pixel metrics of the monitor the app window currently sits on.
   * Used by `useDisplayInfo` to populate dynamic "Max" entries in the
   * screen-share quality + FPS dropdowns.
   *
   * `refreshRate` is 0 when the platform doesn't report it — `useDisplayInfo`
   * uses this as a "hide the Max-Hz option" signal so users never see a
   * "Max (0 Hz)" label.
   */
  getDisplayInfo: () => Promise<{
    width: number;
    height: number;
    refreshRate: number;
    scaleFactor: number;
    monitorCount: number;
  }>;
  /** Reset the native voice-widget window layout; returns false when unavailable. */
  resetOverlayLayout?: () => Promise<boolean>;
  sendOverlayVoiceAction?: (action: "toggle-mute" | "toggle-deafen", session: string) => Promise<boolean>;
  onOverlayVoiceAction?: (callback: (value: { action: "toggle-mute" | "toggle-deafen"; session: string }) => void) => (() => void);
  sendOverlayOpenInbox?: (session: string) => Promise<boolean>;
  confirmOverlayOpenInbox?: (session: string) => Promise<boolean>;
  onOverlayOpenInbox?: (callback: (value: { session: string }) => void) => (() => void);
  sendOverlayPrepareNotificationReply?: (request: { session: string; notificationId: string }) => Promise<boolean>;
  confirmOverlayPrepareNotificationReply?: (request: { session: string; notificationId: string }) => Promise<boolean>;
  onOverlayPrepareNotificationReply?: (callback: (value: { session: string; notificationId: string }) => void) => (() => void);
  sendOverlayOpenChat?: (session: string) => Promise<boolean>;
  confirmOverlayOpenChat?: (session: string) => Promise<boolean>;
  sendOverlayOpenChatComposer?: (session: string) => Promise<boolean>;
  sendOverlayChatMessage?: (request: { session: string; requestId: string; text: string }) => Promise<"sent" | "failed" | "unavailable">;
  closeOverlayChatComposer?: (session: string) => Promise<boolean>;
  onOverlayChatSend?: (callback: (value: { session: string; requestId: string; text: string }) => void) => () => void;
  onOverlayChatComposerClosed?: (callback: (value: { session: string }) => void) => () => void;
  resolveOverlayChatSend?: (value: { session: string; requestId: string; result: "sent" | "failed" | "unavailable" }) => void;
  onOverlayOpenChat?: (callback: (value: { session: string }) => void) => (() => void);
  /** Read local Windows registered-game state; no executable paths are exposed. */
  getRegisteredGames?: () => Promise<ElectronRegisteredGamesSnapshot>;
  getRegisteredGameActivity?: () => Promise<ElectronRegisteredGameActivity>;
  setRegisteredGamesBackgroundDetection?: (enabled: boolean) => Promise<boolean>;
  /** Ask the main process to select and register a local .exe; paths never cross IPC. */
  addRegisteredGame?: () => Promise<ElectronRegisteredGame | null>;
  removeRegisteredGame?: (id: string) => Promise<boolean>;
  /** Local consent groundwork only; game activity upload is not implemented. */
  setRegisteredGameSharing?: (id: string, allowed: boolean) => Promise<boolean>;
  /** Local foreground-window voice-overlay opt-in; unrelated to activity sharing. */
  setRegisteredGameOverlay?: (id: string, allowed: boolean) => Promise<boolean>;
  /** Main process requests screen picker — delivers sources */
  onShowScreenPicker: (cb: (sources: ElectronDesktopSource[]) => void) => void;
  /**
   * Re-query desktop sources while the picker is open. Useful when the
   * target window appeared after the picker first opened.
   */
  refreshScreenPickerSources?: () => void;
  /** Result delivered after refreshScreenPickerSources(). */
  onScreenPickerRefreshResult?: (
    cb: (sources: ElectronDesktopSource[]) => void,
  ) => void;
  /** Detach the refresh-result listener (on picker close). */
  removeScreenPickerRefreshListener?: () => void;
  /** Send user's selection back to main process (null = cancelled) */
  sendScreenPickerResult: (sourceId: string | null) => void;

  /**
   * Subscribe to diagnostic events from the main-process screen picker.
   * Phases: request_handler_start, sources_query_start, sources_query_done,
   * sources_query_error, no_sources, picker_shown, result_received,
   * result_cancelled, handler_error. Extras vary by phase but all include
   * a server-side `timestamp` (ms). Caller is expected to forward to
   * /client-log. Optional — undefined in pre-v2.11.94 Electron builds.
   */
  onScreenPickerDiagnostic?: (
    cb: (event: { phase: string; timestamp: number } & Record<string, unknown>) => void,
  ) => void;

  /** Start process-exclusive system audio capture (excludes our own audio) */
  startSystemCapture: () => Promise<void>;
  stopSystemCapture: () => Promise<void>;
  /** Read bundled helper lifecycle without receiving capture data. */
  getSystemCaptureStatus?: () => Promise<{
    state: "unavailable" | "stopped" | "starting" | "running" | "error";
    reason?: "unsupported_platform" | "helper_missing" | "permission_denied" | "spawn_failed" | "startup_timeout" | "invalid_audio_format" | "exited_before_ready" | "runtime_error";
    owner?: "screen_share" | "diagnostic";
  }>;
  /** Opt-in, discarded-output run; resolves to a token used for owned stop. */
  startSystemCaptureDiagnostic?: () => Promise<string>;
  /** Stops only the matching diagnostic owner. */
  stopSystemCaptureDiagnostic?: (token: string) => Promise<boolean>;
  /** Remove all capture-related IPC listeners to prevent accumulation */
  removeCaptureListeners: () => void;
  onCaptureAudioHeader: (cb: (header: ElectronCaptureAudioHeader) => void) => void;
  onCaptureAudioData: (cb: (data: Uint8Array) => void) => void;
  onCaptureAudioStopped: (cb: () => void) => void;
  onCaptureAudioError: (cb: (msg: string) => void) => void;

  /** Register a key for global PTT detection (works when app is unfocused) */
  registerPTTShortcut: (keyCode: string) => Promise<boolean>;
  /** Unregister the global PTT shortcut */
  unregisterPTTShortcut: () => Promise<void>;
  /** PTT key pressed globally */
  onPTTGlobalDown: (cb: () => void) => void;
  /** PTT key released globally */
  onPTTGlobalUp: (cb: () => void) => void;
  /** Remove global PTT listeners to prevent accumulation */
  removePTTListeners: () => void;

  /**
   * Register a key for the global mute-toggle hotkey (works even when app
   * is unfocused). Mirrors registerPTTShortcut but latches instead of
   * firing down/up pairs. Optional — undefined in Electron builds that
   * predate this feature.
   */
  registerMuteHotkeyShortcut?: (keyCode: string) => Promise<boolean>;
  /** Unregister the global mute-toggle hotkey */
  unregisterMuteHotkeyShortcut?: () => Promise<void>;
  /** Mute hotkey toggled globally */
  onMuteHotkeyGlobal?: (cb: () => void) => void;
  /** Remove global mute hotkey listeners to prevent accumulation */
  removeMuteHotkeyListeners?: () => void;

  /** Save credentials encrypted with safeStorage */
  saveCredentials: (username: string, password: string) => Promise<void>;
  /**
   * Username only — the stored password never crosses the bridge
   * (pentest 2026-07-26, H-09). Use loginWithSavedCredentials to sign in.
   */
  loadCredentials: () => Promise<{ username: string } | null>;
  /**
   * Signs in with the stored password inside the main process and resolves to
   * the upstream login envelope. Rejects when nothing is stored.
   */
  loginWithSavedCredentials: (
    upstreamOrigin: string,
  ) => Promise<{ status: number; body: unknown }>;
  clearCredentials: () => Promise<void>;

  /** Read all app settings */
  getAppSettings: () => Promise<{ openAtLogin: boolean; startMinimized: boolean; closeToTray: boolean; transparentBackground: boolean; hardwareAcceleration: boolean }>;
  setAppSetting: (key: string, value: boolean) => Promise<void>;
  onVoiceOverlayUpdate?: (cb: (snapshot: unknown) => void) => (() => void);
  sendVoiceOverlaySnapshot?: (snapshot: unknown) => void;
  setOverlayShortcut?: (binding: { code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean } | null) => Promise<boolean>;

  /** Custom titlebar window controls */
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  onMaximizedChange: (cb: (isMaximized: boolean) => void) => void;
  removeMaximizedListener: () => void;

  /** Windows taskbar overlay badge. count=0 removes badge. */
  setBadgeCount: (count: number, iconDataURL: string | null) => Promise<void>;
  /** Flash taskbar for incoming message/call attention */
  flashFrame: () => Promise<void>;

  /** Clipboard write via main process IPC — always works */
  writeClipboard: (text: string) => Promise<void>;

  onUpdateAvailable: (cb: (info: ElectronUpdateInfo) => void) => void;
  onUpdateProgress: (cb: (progress: ElectronDownloadProgress) => void) => void;
  onUpdateDownloaded: (cb: (info: ElectronUpdateInfo) => void) => void;
  onUpdateError: (cb: (message: string) => void) => void;
}

declare global {
  interface Window {
    /** Only available in Electron, undefined in browser */
    electronAPI?: ElectronAPI;
  }
}

export {};
