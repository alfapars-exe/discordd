import { createOverlayMediaBroker } from "./overlay-media-broker";
import { registerCS2JoinIPC } from "./cs2-join-ipc";
import { registerGameNameIPC } from "./registered-game-name-ipc";
import {registerSystemAudioLeaseIPC}from "./system-audio-ipc";
import {registerPTTLeaseHandlers}from "./ptt-ipc";
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
 *
 * Input validation policy (audit 2026-05-27):
 * Renderer is untrusted (XSS, malicious extension, compromised preload all
 * count). Every IPC handler that accepts data MUST validate type AND bounds
 * BEFORE calling the domain module. Throw on bad input — the renderer will
 * see the rejection and surface it; silent ignores hide bugs.
 *
 * Helpers below are deliberately ad-hoc (no zod dep) to keep Electron bundle
 * size minimal. If validation gets more complex, switch to a schema lib.
 */

// ──────────────────────────────────────────────────────────────
// Input validation helpers
// ──────────────────────────────────────────────────────────────

/** Per-key validator for app settings — must mirror DEFAULT_APP_SETTINGS shape. */
const APP_SETTING_VALIDATORS: Record<string, (v: unknown) => v is boolean> = {
  openAtLogin: (v): v is boolean => typeof v === "boolean",
  startMinimized: (v): v is boolean => typeof v === "boolean",
  closeToTray: (v): v is boolean => typeof v === "boolean",
  transparentBackground: (v): v is boolean => typeof v === "boolean",
  hardwareAcceleration: (v): v is boolean => typeof v === "boolean",
};

const MAX_CLIPBOARD_BYTES = 10 * 1024 * 1024; // 10 MB — prevent renderer-side DoS
const MAX_BADGE_COUNT = 99999;
const MAX_BADGE_ICON_BYTES = 256 * 1024; // 256 KB data URL
const MAX_PTT_KEYCODE_LEN = 64; // generous bound for any keycode string

function assertString(value: unknown, name: string, maxLen: number): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string, got ${typeof value}`);
  }
  if (value.length > maxLen) {
    throw new RangeError(`${name} exceeds max length ${maxLen}`);
  }
}

function assertFiniteNumber(
  value: unknown,
  name: string,
  min: number,
  max: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${name} must be in [${min}, ${max}]`);
  }
}

import { app, clipboard, dialog, globalShortcut, ipcMain, nativeImage, net, screen, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { getCaptureStatus, startCapture, startDiagnosticCapture, stopCapture, stopDiagnosticCapture,reserveCaptureLease,startCaptureLease,releaseCaptureLease,retireCaptureSender } from "./audio-capture";
import { consumeLastCrash } from "./crash-reporter";
import { appendDiagnostic } from "./diagnostic-log";
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
  toPublicCredentials,
} from "./credentials";
import { loginWithSavedCredentials } from "./credential-login";
import { acquirePTTLease, releasePTTLease, retirePTTSender, registerMuteHotkey, registerPTT, unregisterMuteHotkey, unregisterPTT } from "./push-to-talk";
import { getSerializedSources } from "./screen-picker";
import { DEFAULT_APP_SETTINGS, getSettings, setSetting } from "./settings";
import { setTrayTooltip } from "./tray";
import { wasPrelaunchChecked } from "./auto-updater";
import { getMainWindow } from "./window";
import { getVoiceOverlayMediaWindow, subscribeVoiceOverlayMediaLifecycle, updateVoiceOverlay, toggleVoiceOverlayLock, lockVoiceOverlay, configureVoiceOverlayLayout, resetVoiceOverlayLayout, takeVoiceOverlayAction, takeVoiceOverlayOpenInboxIntent, confirmVoiceOverlayOpenInbox, takeVoiceOverlayNotificationReplyIntent, confirmVoiceOverlayNotificationReply, takeVoiceOverlayOpenChatIntent, confirmVoiceOverlayOpenChat, takeVoiceOverlayOpenChatComposerIntent, sendOverlayChatMessage, closeOverlayChatComposer, resolveOverlayChatSend } from "./voice-overlay";
import { createOverlayLayoutStore } from "./overlay-layout-store";
import { createOverlayShortcutController, type OverlayShortcutBinding } from "./overlay-shortcut";
import { isTrustedVoiceOverlaySender, applyAcknowledgedVoiceOverlaySnapshot, type VoiceOverlaySnapshot } from "./voice-overlay-contract";
import { clearVoiceOverlayGameNotices } from "./voice-overlay";
import { registerOverlayGameNoticeClearIPC } from "./overlay-game-notice-ipc";
import { copyFile, writeFile } from "fs/promises";
import { buildUploadBytes, bundleBaseName, newestCrashDumpFullPath } from "./diagnostic-bundle";
import { getLogsDir, setVerbose } from "./diagnostic-log";
import { cancelPerformanceTrace, capturePerformanceTrace } from "./performance-trace";
import { createRegisteredGamesService } from "./registered-games";
import { createGameWindowTracker } from "./game-window-tracker";
import { createGameOverlayController } from "./game-overlay-controller";
import { existsSync } from "node:fs";
import path from "node:path";

// Compact local timestamp (YYYYMMDD-HHmmss) for diagnostics filenames.
function diagStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function registerIpcHandlers(): void {
  const gameJoin = registerCS2JoinIPC(ipcMain, assertTrustedMainWindowSender, {
    fetch: (url, init) => net.fetch(url, init), openExternal: url => shell.openExternal(url),
    allowLoopback: !app.isPackaged, supported: process.platform === "win32",
  });
  app.once("before-quit", () => gameJoin.dispose());
  // Start the middle-left layout generation without restoring old bottom-edge
  // drag offsets. New drag positions remain persistent in this generation.
  const overlayLayouts = createOverlayLayoutStore({ filePath: path.join(app.getPath("userData"), "overlay-layout-v2.json") });
  configureVoiceOverlayLayout(overlayLayouts);
  ipcMain.handle("reset-overlay-layout", (event) => {
    assertTrustedMainWindowSender(event);
    return resetVoiceOverlayLayout();
  });
  ipcMain.handle("overlay-voice-action", (event, action: unknown, session: unknown) => {
    const request = takeVoiceOverlayAction(event, action, session);
    const main = getMainWindow();
    if (!request || !main || main.isDestroyed()) return false;
    main.webContents.send("overlay-voice-action", request);
    return true;
  });
  ipcMain.handle("overlay-open-inbox", (event, session: unknown) => {
    const request = takeVoiceOverlayOpenInboxIntent(event, session);
    const main = getMainWindow();
    if (!request || !main || main.isDestroyed()) return false;
    main.webContents.send("overlay-open-inbox", request);
    return true;
  });
  ipcMain.handle("confirm-overlay-open-inbox", (event, session: unknown) => {
    return confirmVoiceOverlayOpenInbox(event, session, getMainWindow());
  });
  ipcMain.handle("overlay-prepare-notification-reply", (event, raw: unknown) => {
    const request = takeVoiceOverlayNotificationReplyIntent(event, raw), main = getMainWindow();
    if (!request || !main || main.isDestroyed()) return false;
    main.webContents.send("overlay-prepare-notification-reply", request); return true;
  });
  ipcMain.handle("confirm-overlay-prepare-notification-reply", (event, raw: unknown) => confirmVoiceOverlayNotificationReply(event, raw, getMainWindow()));
  ipcMain.handle("overlay-open-chat", (event, session: unknown) => {
    const request = takeVoiceOverlayOpenChatIntent(event, session);
    const main = getMainWindow();
    if (!request || !main || main.isDestroyed()) return false;
    main.webContents.send("overlay-open-chat", request);
    return true;
  });
  ipcMain.handle("confirm-overlay-open-chat", (event, session: unknown) => {
    return confirmVoiceOverlayOpenChat(event, session, getMainWindow());
  });
  ipcMain.handle("overlay-open-chat-composer", (event, session: unknown) => {
    return !!takeVoiceOverlayOpenChatComposerIntent(event, session, getMainWindow());
  });
  ipcMain.handle("overlay-chat-send", (event, request: unknown) => sendOverlayChatMessage(event, request, getMainWindow()));
  ipcMain.handle("close-overlay-chat-composer", (event, session: unknown) => closeOverlayChatComposer(event, session));
  ipcMain.handle("resolve-overlay-chat-send", (event, request: unknown) => resolveOverlayChatSend(event, request, getMainWindow()));
  const overlayShortcut = createOverlayShortcutController({
    supported: process.platform === "win32",
    register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
    unregister: (accelerator) => globalShortcut.unregister(accelerator),
  }, toggleVoiceOverlayLock);
  ipcMain.handle("set-overlay-shortcut", (event, binding: unknown) => {
    assertTrustedMainWindowSender(event);
    const accepted = overlayShortcut.setBinding(binding as OverlayShortcutBinding | null);
    if (binding === null) lockVoiceOverlay();
    return accepted;
  });
  let overlayMediaPolicy: VoiceOverlaySnapshot | null = null;
  const overlayMedia = createOverlayMediaBroker({main:getMainWindow,overlay:getVoiceOverlayMediaWindow,policy:()=>overlayMediaPolicy});
  const stopOverlayMediaLifecycle = subscribeVoiceOverlayMediaLifecycle(revoke => { if(revoke)overlayMedia.revoke();else overlayMedia.refresh(); });
  ipcMain.handle("open-overlay-media-lease", (event, raw:unknown) => overlayMedia.open(event,raw));
  ipcMain.handle("send-overlay-media", (event, raw:unknown) => overlayMedia.send(event,raw));
  ipcMain.handle("send-overlay-media-viewport", (event, raw:unknown) => overlayMedia.viewport(event,raw));
  ipcMain.handle("set-overlay-media-receiver-ready", (event, ready:unknown) => overlayMedia.setReady(event,ready));
  ipcMain.handle("get-overlay-media-availability", event => overlayMedia.getAvailability(event));
  let gameOverlay: ReturnType<typeof createGameOverlayController> | undefined;
  const gameHelperPath = app.isPackaged
    ? path.join(process.resourcesPath, "native", "game-window.exe")
    : path.join(app.getAppPath(), "native", "game-window.exe");
  const gameOverlaySupported = process.platform === "win32" && existsSync(gameHelperPath);
  const registeredGames = createRegisteredGamesService({
    filePath: path.join(app.getPath("userData"), "registered-games.json"),
    onOverlayPolicyChanged: () => { void gameOverlay?.policyChanged().catch(() => undefined); },
  });
  // Unsupported platforms and absent optional helpers must not break app startup.
  const gameWindowTracker = gameOverlaySupported
    ? createGameWindowTracker({ helperPath: gameHelperPath, onChange: () => gameOverlay?.foregroundChanged() })
    : { start: () => {}, stop: async () => {}, dispose: async () => {}, getSnapshot: () => null };
  gameOverlay = createGameOverlayController({
    tracker: gameWindowTracker,
    getTargets: () => registeredGames.getOverlayTargets(),
    supported: gameOverlaySupported,
    display: updateVoiceOverlay,
    toVisibleDipRect: (rect) => {
      const dip = screen.screenToDipRect(null, rect);
      const area = screen.getDisplayMatching(dip).workArea;
      const x = Math.max(dip.x, area.x), y = Math.max(dip.y, area.y);
      const right = Math.min(dip.x + dip.width, area.x + area.width);
      const bottom = Math.min(dip.y + dip.height, area.y + area.height);
      return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
    },
  });
  void registeredGames.initialize().catch(() => undefined);
  app.on("web-contents-created", (_event, contents) => {
    contents.on("destroyed", () => { overlayMedia.retireForContents(contents); });
    contents.on("render-process-gone", () => {
      if (getMainWindow()?.webContents === contents) { overlayMediaPolicy=null; overlayMedia.revoke(); gameOverlay?.clear(); overlayShortcut.setBinding(null); }
    });
    contents.on("did-start-navigation", (_navigationEvent, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace && getMainWindow()?.webContents === contents) { overlayMediaPolicy=null; overlayMedia.revoke(); gameOverlay?.clear(); overlayShortcut.setBinding(null); }
    });
  });
  app.once("before-quit", () => { stopOverlayMediaLifecycle(); overlayMedia.revoke(); overlayShortcut.dispose(); gameOverlay?.dispose(); registeredGames.dispose(); void gameWindowTracker.dispose(); });

  ipcMain.handle("get-registered-games", (event) => {
    assertTrustedMainWindowSender(event);
    return registeredGames.snapshot().then((snapshot) => ({ ...snapshot, overlaySupport: process.platform !== "win32" ? "unsupported" : gameOverlaySupported ? "available" : "unavailable" }));
  });
  ipcMain.handle("get-registered-game-activity", (event) => {
    assertTrustedMainWindowSender(event);
    return registeredGames.getActivity();
  });
  ipcMain.handle("set-registered-games-background-detection", async (event, enabled: unknown) => {
    assertTrustedMainWindowSender(event);
    if (typeof enabled !== "boolean") throw new TypeError("background detection setting must be boolean");
    return registeredGames.setBackgroundDetectionEnabled(enabled);
  });
  ipcMain.handle("add-registered-game", async (event) => {
    assertTrustedMainWindowSender(event);
    if (process.platform !== "win32") return null;
    const result = await dialog.showOpenDialog({
      title: "Select a game executable",
      properties: ["openFile"],
      filters: [{ name: "Windows applications", extensions: ["exe"] }],
    });
    const selected = result.canceled ? undefined : result.filePaths[0];
    return selected ? registeredGames.addExecutable(selected) : null;
  });
  ipcMain.handle("remove-registered-game", async (event, id: unknown) => {
    assertTrustedMainWindowSender(event);
    assertString(id, "game id", 64);
    const removed = await registeredGames.remove(id);
    if (removed) overlayLayouts.remove(`game:${id}`);
    return removed;
  });
  registerGameNameIPC(ipcMain, assertTrustedMainWindowSender, registeredGames);
  ipcMain.handle("set-registered-game-join-adapter", (event, id: unknown, adapter: unknown) => {
    assertTrustedMainWindowSender(event);
    assertString(id, "registered game id", 64);
    return registeredGames.setJoinAdapter(id, adapter);
  });

  ipcMain.handle("set-registered-game-sharing", async (event, id: unknown, allowed: unknown) => {
    assertTrustedMainWindowSender(event);
    assertString(id, "game id", 64);
    if (typeof allowed !== "boolean") throw new TypeError("sharing permission must be boolean");
    return registeredGames.setShareAllowed(id, allowed);
  });

  const applyOverlaySnapshot = (event: Parameters<typeof isTrustedMainWindowSender>[0], raw: unknown): boolean =>
    applyAcknowledgedVoiceOverlaySnapshot(raw, isTrustedMainWindowSender(event), {
      setSuspended: value => overlayShortcut.setSuspended(value),
      setSnapshot: snapshot => { overlayMediaPolicy=snapshot; overlayMedia.refresh(); gameOverlay?.setSnapshot(snapshot); },
    });
  ipcMain.on("voice-overlay-snapshot", applyOverlaySnapshot);
  ipcMain.handle("voice-overlay-snapshot", applyOverlaySnapshot);
  registerOverlayGameNoticeClearIPC(ipcMain, assertTrustedMainWindowSender, () => {
    clearVoiceOverlayGameNotices(overlayMediaPolicy?.gameActivityNotices ?? []);
    if (overlayMediaPolicy) {
      overlayMediaPolicy = { ...overlayMediaPolicy, gameActivityNotices: [] };
      gameOverlay?.setSnapshot(overlayMediaPolicy);
    }
  });
  ipcMain.handle("set-registered-game-overlay", async (event, id: unknown, allowed: unknown) => {
    assertTrustedMainWindowSender(event);
    assertString(id, "game id", 64);
    if (typeof allowed !== "boolean") throw new TypeError("overlay permission must be boolean");
    return registeredGames.setOverlayAllowed(id, allowed);
  });
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

  // ─── Diagnostic log tee (renderer → local rolling file) ──────────
  // The renderer mirrors every logToServer event here so it persists locally
  // even when the best-effort server send drops (offline / pre-login / WS down
  // / crash). Untrusted input: validate + cap, and force source="renderer"
  // (the renderer cannot claim to be main/native). Fire-and-forget, no reply.
  ipcMain.on("diagnostic-log", (_event, raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const e = raw as { level?: unknown; msg?: unknown; category?: unknown; meta?: unknown };
    if (typeof e.msg !== "string" || e.msg.length === 0 || e.msg.length > 2000) return;
    const level = e.level === "warn" || e.level === "error" ? e.level : "info";
    const category = typeof e.category === "string" && e.category.length <= 64 ? e.category : "";
    const meta =
      e.meta && typeof e.meta === "object" && !Array.isArray(e.meta)
        ? (e.meta as Record<string, unknown>)
        : undefined;
    appendDiagnostic({ level, source: "renderer", category, msg: e.msg, meta });
  });

  // ─── Diagnostics bundle: build / export / open ───────────────────
  // Build the gzipped bundle bytes and hand them to the renderer, which uploads
  // through the existing feedback channel (it owns the API base URL + token).
  // A Node Buffer serializes to the renderer as a Uint8Array.
  ipcMain.handle("build-diagnostic-upload", async () => {
    const data = await buildUploadBytes();
    return { filename: `${bundleBaseName()}-${diagStamp()}.json.gz`, data };
  });

  // Save the bundle to a user-chosen file. If a native crash dump exists it is
  // copied alongside (too large to fold into the gzipped JSON / a feedback
  // upload). Returns {saved, path?, dumpCopied?}.
  ipcMain.handle("export-diagnostics", async () => {
    const data = await buildUploadBytes();
    const win = getMainWindow();
    const defaultPath = `${bundleBaseName()}-${diagStamp()}.json.gz`;
    const opts = {
      defaultPath,
      filters: [{ name: "Diagnostics", extensions: ["gz"] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) return { saved: false };
    await writeFile(result.filePath, data);

    let dumpCopied = false;
    const dump = newestCrashDumpFullPath();
    if (dump) {
      try {
        const dest = result.filePath.replace(/\.json\.gz$/i, "") + ".dmp";
        await copyFile(dump, dest);
        dumpCopied = true;
      } catch {
        /* dump copy is best-effort — the gzipped bundle is the primary artifact */
      }
    }
    return { saved: true, path: result.filePath, dumpCopied };
  });

  // Open the folder holding the rolling logs (so the user can grab a dump or the
  // raw files directly).
  ipcMain.handle("open-logs-dir", () => shell.openPath(getLogsDir()));

  // Verbose diagnostic logging toggle (persisted in app settings, applied live).
  ipcMain.handle("get-diagnostic-verbose", () => getSettings().diagnosticVerbose === true);
  ipcMain.handle("set-diagnostic-verbose", (_event, value: unknown) => {
    if (typeof value !== "boolean") throw new TypeError("value must be a boolean");
    setSetting("diagnosticVerbose", value);
    setVerbose(value);
  });
  ipcMain.handle("capture-performance-trace", () => capturePerformanceTrace());
  ipcMain.handle("cancel-performance-trace", () => cancelPerformanceTrace());

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

  registerSystemAudioLeaseIPC(ipcMain,assertTrustedMainWindowSender,{reserve:reserveCaptureLease,start:startCaptureLease,release:releaseCaptureLease,retire:retireCaptureSender});
  // ─── Process-exclusive system audio ──────────────────────────────
  ipcMain.handle("start-system-capture", event => {assertTrustedMainWindowSender(event);return startCapture();});
  ipcMain.handle("stop-system-capture", event => {assertTrustedMainWindowSender(event);return stopCapture();});
  ipcMain.handle("get-system-capture-status", () => getCaptureStatus());
  ipcMain.handle("start-system-capture-diagnostic", () => startDiagnosticCapture());
  ipcMain.handle("stop-system-capture-diagnostic", (_event, token: unknown) => {
    if (typeof token !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      throw new TypeError("diagnostic capture token is invalid");
    }
    return stopDiagnosticCapture(token);
  });

  // ─── Taskbar overlay icon (Windows unread badge) ─────────────────
  ipcMain.handle(
    "set-badge-count",
    (_e: Electron.IpcMainInvokeEvent, count: unknown, iconDataURL: unknown) => {
      // Audit 2026-05-27: validate untrusted renderer input.
      assertFiniteNumber(count, "badge count", 0, MAX_BADGE_COUNT);
      if (iconDataURL !== null) {
        assertString(iconDataURL, "iconDataURL", MAX_BADGE_ICON_BYTES);
        // Restrict to data:image/* — refuse javascript:, file:, http:, etc.
        if (!iconDataURL.startsWith("data:image/")) {
          throw new TypeError("iconDataURL must be a data:image/* URL");
        }
      }
      const win = getMainWindow();
      if (!win) return;
      if (count === 0 || !iconDataURL) {
        win.setOverlayIcon(null, "");
      } else {
        // iconDataURL is narrowed to string by assertString above
        win.setOverlayIcon(
          nativeImage.createFromDataURL(iconDataURL),
          `${count} unread`,
        );
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
  ipcMain.handle("write-clipboard", (_e, text: unknown) => {
    // Audit 2026-05-27: prevent renderer-induced clipboard DoS.
    assertString(text, "clipboard text", MAX_CLIPBOARD_BYTES);
    clipboard.writeText(text);
  });

  // ─── App settings (general / windows) ────────────────────────────
  ipcMain.handle("get-app-settings", () => {
    // Reflect actual OS state — user may have toggled openAtLogin via
    // Windows registry / Settings outside the app.
    const live = app.getLoginItemSettings();
    const cached = getSettings();
    cached.openAtLogin = live.openAtLogin;
    return cached;
  });

  ipcMain.handle("set-app-setting", (_e, key: unknown, value: unknown) => {
    // Audit 2026-05-27: full type+range validation.
    // Previously only validated key existence — value of any type was
    // persisted, enabling renderer-induced config corruption (e.g. setting
    // closeToTray=null silently broke the X button on next launch).
    if (typeof key !== "string" || !(key in DEFAULT_APP_SETTINGS)) {
      throw new TypeError(`unknown app setting: ${String(key)}`);
    }
    // Optional chain — undefined validator short-circuits to undefined,
    // which is falsy, so the throw fires (same semantics as before).
    if (!APP_SETTING_VALIDATORS[key]?.(value)) {
      throw new TypeError(
        `invalid value for ${key}: expected boolean, got ${typeof value}`,
      );
    }
    setSetting(key, value);
    if (key === "openAtLogin") {
      app.setLoginItemSettings({ openAtLogin: value });
    }
  });

  // ─── Credentials (Remember Me, DPAPI/Keychain encrypted) ─────────
  ipcMain.handle(
    "save-credentials",
    (_e, username: unknown, password: unknown) => {
      // Audit 2026-05-27: bound credential field lengths to prevent
      // disk-fill via huge string write.
      assertString(username, "username", 512);
      assertString(password, "password", 4096);
      return saveCredentials(username, password);
    },
  );
  // Username only. The password stays in the main process (pentest
  // 2026-07-26, H-09): handing it to the renderer meant any XSS in
  // app://hichat could read a long-lived account password, which is the one
  // secret the short-lived-token design is there to avoid holding.
  ipcMain.handle("load-credentials", () => toPublicCredentials(loadCredentials()));
  // Logs in using the stored password without ever exposing it. Returns
  // exactly what a renderer-issued login returns: status + parsed body.
  ipcMain.handle("login-with-saved-credentials", (_e, upstreamOrigin: unknown) =>
    loginWithSavedCredentials(upstreamOrigin, (input, init) => net.fetch(input, init)),
  );
  ipcMain.handle("clear-credentials", () => clearCredentials());

  registerPTTLeaseHandlers(ipcMain,assertTrustedMainWindowSender,{acquire:acquirePTTLease,release:releasePTTLease,retire:retirePTTSender});
  // ─── Push-to-Talk shortcuts (uIOhook global keyboard) ────────────
  ipcMain.handle("register-ptt-shortcut", (_e, keyCode: unknown) => {
    assertTrustedMainWindowSender(_e);
    // Audit 2026-05-27: keyCode is mapped against an allowlist inside
    // registerPTT(), but bound the string here defensively to avoid
    // pathological inputs reaching the keymap lookup.
    assertString(keyCode, "PTT keyCode", MAX_PTT_KEYCODE_LEN);
    return registerPTT(keyCode);
  });
  ipcMain.handle("unregister-ptt-shortcut", (event) => {assertTrustedMainWindowSender(event);unregisterPTT();});

  // ─── Global mute-toggle hotkey (uIOhook, shares the PTT hook) ────
  ipcMain.handle("register-mute-hotkey-shortcut", (_e, keyCode: unknown) => {
    // Same validation policy as register-ptt-shortcut above.
    assertString(keyCode, "mute hotkey keyCode", MAX_PTT_KEYCODE_LEN);
    return registerMuteHotkey(keyCode);
  });
  ipcMain.handle("unregister-mute-hotkey-shortcut", () => unregisterMuteHotkey());
}

function isTrustedMainWindowSender(event: { sender: unknown; senderFrame: unknown }): boolean {
  return isTrustedVoiceOverlaySender(event, getMainWindow());
}

function assertTrustedMainWindowSender(event: { sender: unknown; senderFrame: unknown }): void {
  if (!isTrustedMainWindowSender(event)) throw new Error("Untrusted IPC sender.");
}
