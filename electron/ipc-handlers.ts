import { registerAppCommandIPC } from "./app-command-ipc";
import { registerCaptureCommandIPC } from "./capture-command-ipc";
import { registerGlobalShortcutIPC } from "./global-shortcut-ipc";
import { registerRegisteredGamesIPC } from "./registered-games-ipc";
import { registerWindowControlIPC } from "./window-control-ipc";
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

export function registerIpcHandlers(): () => Promise<void> {
  const gameJoin = registerCS2JoinIPC(ipcMain, assertTrustedMainWindowSender, {
    fetch: (url, init) => net.fetch(url, init), openExternal: url => shell.openExternal(url),
    allowLoopback: !app.isPackaged, supported: process.platform === "win32",
  });
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

  registerRegisteredGamesIPC(ipcMain, {
    trusted: assertTrustedMainWindowSender, assertString, registeredGames,
    platform: process.platform, overlaySupported: gameOverlaySupported,
    showOpenDialog: options => dialog.showOpenDialog(options),
    removeLayout: key => overlayLayouts.remove(key),
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

  // ─── App / version ──────────────────────────────────────────────
  registerAppCommandIPC(ipcMain, {
    getVersion: () => app.getVersion(), relaunch: () => app.relaunch(), quit: () => app.quit(),
    writeClipboard: text => clipboard.writeText(text), assertString,
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
  registerCaptureCommandIPC(ipcMain, assertTrustedMainWindowSender, {
    startCapture, stopCapture, getCaptureStatus, startDiagnosticCapture, stopDiagnosticCapture,
  });

  // ─── Taskbar overlay icon (Windows unread badge) ─────────────────
  registerWindowControlIPC(ipcMain, {
    getMainWindow, setTrayTooltip, assertString, assertFiniteNumber,
    createBadgeImage: url => nativeImage.createFromDataURL(url),
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
  registerGlobalShortcutIPC(ipcMain, {
    trusted: assertTrustedMainWindowSender, assertString,
    registerPTT, unregisterPTT, registerMuteHotkey, unregisterMuteHotkey,
  });
  let cleanup: Promise<void> | null = null;
  return () => {
    const stops: Array<() => unknown> = [
      () => gameJoin.dispose(), stopOverlayMediaLifecycle, () => overlayMedia.revoke(),
      () => overlayShortcut.dispose(), () => gameOverlay?.dispose(),
      () => registeredGames.dispose(), () => gameWindowTracker.dispose(),
    ];
    cleanup ??= Promise.allSettled(stops.map(stop => Promise.resolve().then(stop))).then(results => {
      if (results.some(result => result.status === "rejected")) throw new Error("IPC cleanup failed");
    });
    return cleanup;
  };
}

function isTrustedMainWindowSender(event: { sender: unknown; senderFrame: unknown }): boolean {
  return isTrustedVoiceOverlaySender(event, getMainWindow());
}

function assertTrustedMainWindowSender(event: { sender: unknown; senderFrame: unknown }): void {
  if (!isTrustedMainWindowSender(event)) throw new Error("Untrusted IPC sender.");
}
