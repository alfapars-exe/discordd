import { registerDesktopMediaIPC } from "./desktop-media-ipc";
import { registerOverlayActionIPC } from "./overlay-action-ipc";
import { registerDiagnosticIPC } from "./diagnostic-ipc";
import { registerUpdaterIPC } from "./updater-ipc";
import { requestUpdateInstallation } from "./update-installation";
import { registerAppSettingsIPC } from "./app-settings-ipc";
import { registerCredentialIPC } from "./credential-ipc";
import { assertString, assertFiniteNumber } from "./ipc-input-validation";
import { createOverlayMediaBroker } from "./overlay-media-broker";
import { registerCS2JoinIPC } from "./cs2-join-ipc";
import { registerGameNameIPC } from "./registered-game-name-ipc";
import {registerSystemAudioLeaseIPC}from "./system-audio-ipc";
import {registerPTTLeaseHandlers}from "./ptt-ipc";
/**
 * electron/ipc-handlers.ts — Centralized IPC channel registration.
 *
 * Compose renderer→main IPC handlers and domain registrars. Each registrar
 * keeps its channel contracts and validation next to its domain operations.
 *
 * This composition root supplies the same sender predicates and platform
 * adapters to domain registrars while domain logic stays unit-testable.
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

const MAX_CLIPBOARD_BYTES = 10 * 1024 * 1024; // 10 MB — prevent renderer-side DoS
const MAX_BADGE_COUNT = 99999;
const MAX_BADGE_ICON_BYTES = 256 * 1024; // 256 KB data URL
const MAX_PTT_KEYCODE_LEN = 64; // generous bound for any keycode string

import { app, clipboard, dialog, globalShortcut, ipcMain, nativeImage, net, screen, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { getCaptureStatus, startCapture, startDiagnosticCapture, stopCapture, stopDiagnosticCapture,reserveCaptureLease,startCaptureLease,releaseCaptureLease,retireCaptureSender } from "./audio-capture";
import { consumeLastCrash } from "./crash-reporter";
import { appendDiagnostic } from "./diagnostic-log";
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
} from "./credentials";
import { loginWithSavedCredentials } from "./credential-login";
import { acquirePTTLease, releasePTTLease, retirePTTSender, registerMuteHotkey, registerPTT, unregisterMuteHotkey, unregisterPTT } from "./push-to-talk";
import { getSerializedSources } from "./screen-picker";
import { getSettings, setSetting } from "./settings";
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
  registerOverlayActionIPC(ipcMain, { takeVoiceOverlayAction, takeVoiceOverlayOpenInboxIntent, confirmVoiceOverlayOpenInbox, takeVoiceOverlayNotificationReplyIntent, confirmVoiceOverlayNotificationReply, takeVoiceOverlayOpenChatIntent, confirmVoiceOverlayOpenChat, takeVoiceOverlayOpenChatComposerIntent, sendOverlayChatMessage, closeOverlayChatComposer, resolveOverlayChatSend, getMainWindow });
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

  registerDiagnosticIPC(ipcMain, {
    consumeLastCrash, appendDiagnostic, buildUploadBytes, bundleBaseName,
    now: () => new Date(),
    showSaveDialog: options => {
      const win = getMainWindow();
      return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
    },
    writeFile, copyFile, newestCrashDumpFullPath,
    openLogs: () => shell.openPath(getLogsDir()),
    isVerbose: () => getSettings().diagnosticVerbose === true,
    persistVerbose: value => setSetting("diagnosticVerbose", value),
    setVerbose, capturePerformanceTrace, cancelPerformanceTrace,
  });
  registerUpdaterIPC(ipcMain, {
    wasPrelaunchChecked,
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    downloadUpdate: () => autoUpdater.downloadUpdate(),
    quitAndInstall: (silent, restart) => requestUpdateInstallation(() => autoUpdater.quitAndInstall(silent, restart), autoUpdater),
  });
  // ─── Desktop capturer (legacy enumeration, separate from picker) ─
  registerDesktopMediaIPC(ipcMain, { getSerializedSources, getMainWindow, screen });

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

  registerAppSettingsIPC(ipcMain, {
    getSettings,
    setSetting,
    getLoginItemSettings: () => app.getLoginItemSettings(),
    setLoginItemSettings: value => app.setLoginItemSettings(value),
  });

  // Credential IPC retains main-frame authorization and main-only passwords.
  registerCredentialIPC(ipcMain, assertTrustedMainWindowSender, {
    save: saveCredentials,
    load: loadCredentials,
    clear: clearCredentials,
    login: upstream => loginWithSavedCredentials(upstream, (input, init) => net.fetch(input, init)),
  });

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
