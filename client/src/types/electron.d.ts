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
}

interface ElectronAPI {
  getVersion: () => Promise<string>;
  relaunch: () => Promise<void>;
  /**
   * Read & clear the persisted crash record (if any) from the previous run.
   * Returns null when there's nothing to report.
   */
  consumeLastCrash: () => Promise<ElectronCrashRecord | null>;

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

  /** Start process-exclusive system audio capture (excludes our own audio) */
  startSystemCapture: () => Promise<void>;
  stopSystemCapture: () => Promise<void>;
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

  /** Save credentials encrypted with safeStorage */
  saveCredentials: (username: string, password: string) => Promise<void>;
  loadCredentials: () => Promise<{ username: string; password: string } | null>;
  clearCredentials: () => Promise<void>;

  /** Read all app settings */
  getAppSettings: () => Promise<{ openAtLogin: boolean; startMinimized: boolean; closeToTray: boolean; transparentBackground: boolean }>;
  setAppSetting: (key: string, value: boolean) => Promise<void>;

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
