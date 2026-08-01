/**
 * electron/window.ts — Main BrowserWindow lifecycle.
 *
 * Single responsibility: create the main window, persist its bounds,
 * and expose a reference for other modules. Close-to-tray, F12 devtools,
 * and ready-to-show flicker prevention live here.
 *
 * Does NOT register IPC. Does NOT send anything through the window — other
 * modules import `getMainWindow()` when they need to reach the renderer.
 * The one exception is push-to-talk.ts: this file calls its
 * shutdownGlobalHotkeys() when the window's renderer is gone (crashed or
 * the window itself closed), so the global uIOhook keyboard hook never
 * outlives the window that owns it. That's a one-way cleanup call, not a
 * binding or a signal — push-to-talk.ts still owns all hotkey state.
 */

import { app, BrowserWindow, Menu, screen, shell } from "electron";
import path from "path";
import { getSettings, getWindowBounds, saveWindowBounds, WindowBounds } from "./settings";

// Which origins the renderer may navigate to in-place lives in a pure,
// unit-tested module (navigation-policy.ts) — importing `electron` here
// makes this file unloadable outside the Electron runtime, so the policy
// itself is kept separate the same way resolve-path.ts is.
import { isInternalNavigation } from "./navigation-policy";

// See the header note above — the only reason this file reaches into
// push-to-talk.ts. Referenced only inside event-handler callbacks below
// (never at module load time), so the require cycle with push-to-talk.ts
// (which imports getMainWindow from this file) resolves safely: both
// modules are fully loaded well before either callback can fire.
import { shutdownGlobalHotkeys } from "./push-to-talk";

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

/**
 * Set to true by auto-updater when an installer has finished downloading.
 * When this is true, close-to-tray is bypassed — clicking X behaves like
 * "Quit" so app.quit() fires and `autoInstallOnAppQuit` actually installs
 * the update. Without this, tray-only users (who never explicitly Quit)
 * stayed forever on whatever version was installed when they first
 * launched, because their main process never died and the
 * autoInstallOnAppQuit branch never ran.
 */
let updateDownloaded = false;

/** Read-only access for other modules that need to send IPC events. */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Mark that the next "close" should actually quit (called by tray Quit / before-quit). */
export function setQuitting(v: boolean): void {
  isQuitting = v;
}

export function isQuittingNow(): boolean {
  return isQuitting;
}

/**
 * Called by auto-updater when an installer is downloaded and waiting to
 * apply. Changes close-button semantics so a tray-only user actually
 * triggers app.quit() (and thus autoInstallOnAppQuit) instead of going
 * to tray and staying there forever.
 */
export function setUpdateDownloaded(): void {
  updateDownloaded = true;
}

let boundsTimer: ReturnType<typeof setTimeout> | null = null;

/** Save current bounds to settings (debounced 500ms to avoid drag-storm writes). */
function persistBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const isMaximized = mainWindow.isMaximized();
    // getNormalBounds() returns pre-maximize bounds — preserves restore size
    const rect = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    saveWindowBounds({ ...rect, isMaximized });
  }, 500);
}

/** Whether the saved bounds intersect any currently connected display. */
function visibleOnScreen(bounds: WindowBounds): boolean {
  for (const display of screen.getAllDisplays()) {
    const { x, y, width, height } = display.workArea;
    const overlapX = Math.max(0, Math.min(bounds.x + bounds.width, x + width) - Math.max(bounds.x, x));
    const overlapY = Math.max(0, Math.min(bounds.y + bounds.height, y + height) - Math.max(bounds.y, y));
    if (overlapX > 100 && overlapY > 50) return true;
  }
  return false;
}

export function createMainWindow(): BrowserWindow {
  const settings = getSettings();
  const saved = getWindowBounds();
  const useSaved = saved && visibleOnScreen(saved);
  const isTransparent = settings.transparentBackground;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    // Explicit title — without this, the window flashes "Electron" between
    // BrowserWindow creation and the renderer's <title> tag attaching to
    // the DOM. Also covers Alt+Tab listing in the brief gap before the
    // page loads, and the WM_GETTEXT fallback some screen readers / OS
    // utilities query before the DOM title is ready.
    title: "HiChat!",
    icon: path.join(__dirname, "../icons/hlogo.png"),
    transparent: isTransparent,
    ...(isTransparent ? {} : { backgroundColor: "#111111" }),
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true puts the renderer + preload into Chromium's
      // OS-level sandbox. Combined with contextIsolation this makes the
      // common XSS-to-RCE chain (loadModule via shared globals,
      // process.* leakage, fs access from renderer) materially harder.
      // Preload code can still use contextBridge.exposeInMainWorld and
      // ipcRenderer — no functional impact for our IPC surface.
      sandbox: true,
      // webSecurity is on by default, but setting it explicitly documents
      // intent and prevents an accidental flip during a future refactor.
      webSecurity: true,
      // Block stale Chromium feature flags / DevTools shortcuts from
      // exposing data via the renderer when the app is packaged.
      devTools: !app.isPackaged,
      backgroundThrottling: false,
    },
  });

  // Two-step restore: position first, then size — Windows applies the right
  // DPI context for mixed-display setups when position is set on the target
  // display before size.
  if (useSaved) {
    mainWindow.setPosition(saved!.x, saved!.y);
    mainWindow.setSize(saved!.width, saved!.height);
  }

  mainWindow.once("ready-to-show", () => {
    if (!settings.startMinimized) {
      if (useSaved && saved!.isMaximized) mainWindow?.maximize();
      mainWindow?.show();
    }
  });

  mainWindow.on("move", persistBounds);
  mainWindow.on("resize", persistBounds);
  mainWindow.on("maximize", () => {
    mainWindow?.webContents.send("window-maximized-change", true);
    persistBounds();
  });
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("window-maximized-change", false);
    persistBounds();
  });

  Menu.setApplicationMenu(null);

  // ELECTRON_FORCE_PROD=1 exercises the app:// production loading path
  // even from a dev checkout (needed to smoke-test the protocol handler
  // without a full electron:build cycle). Otherwise dev uses Vite HMR.
  const isDev =
    process.env.ELECTRON_FORCE_PROD !== "1" &&
    (process.env.NODE_ENV === "development" || !app.isPackaged);
  if (isDev) {
    mainWindow.loadURL("http://localhost:3030");
  } else {
    // app://hichat/index.html serves out of client/dist via the protocol
    // handler in main.ts:setupAppProtocol. loadFile with file:// no longer
    // works — file:// is a null origin and the server-side CORS + cookie
    // flow rejects it. See T1.4/T1.5 for the full rationale.
    mainWindow.loadURL("app://hichat/index.html");
  }

  // F12 toggles DevTools — only in development. Leaving DevTools accessible
  // in production lets a curious user (or someone with brief physical access)
  // read session tokens out of memory, inspect E2EE state, and copy/paste
  // their access token to leak it. The forensic value isn't worth the risk
  // for a Discord-class app; users on Electron get the same support story
  // as the desktop competitors (no DevTools in shipped builds).
  if (isDev) {
    mainWindow.webContents.on("before-input-event", (_e, input) => {
      if (input.key === "F12") mainWindow?.webContents.toggleDevTools();
    });
  }

  // Navigation policy: external URLs open in the user's default browser,
  // never inside our chromeless window. A phishing link in a message that
  // resolved inside the Electron shell could impersonate the app perfectly
  // (no URL bar, our logo at the title) — punting to the OS browser shows
  // the real address and the user's installed extensions/malware filters.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // shell.openExternal validates the URL with the OS — invalid schemes
    // (file://, javascript:, custom protocols) silently fail to open.
    // We still gate on http(s) explicitly to avoid handing weird URIs
    // to OS handlers that might do something surprising.
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Block in-place navigation away from the bundle. The renderer normally
  // uses React Router (which doesn't trigger will-navigate), so any real
  // navigation event here is either a user-clicked external link that
  // slipped past setWindowOpenHandler or an injected redirect attempt.
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!isInternalNavigation(url)) {
      e.preventDefault();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        shell.openExternal(url);
      }
    }
  });

  // If the renderer dies (crash, OOM, killed) the global keyboard hook has
  // no one left to signal — registerPTT/registerMuteHotkey's IPC listeners
  // are gone with it, so the hook would otherwise keep running (and keep
  // comparing every system keystroke) for a dead window until the whole
  // app quits. Shut it down here; a future createMainWindow() call (or the
  // renderer coming back) re-registers whatever the user still has enabled.
  mainWindow.webContents.on("render-process-gone", () => {
    shutdownGlobalHotkeys();
  });

  // Close-to-tray: hide instead of quit unless tray Quit was clicked.
  //
  // Exception: when an update installer is downloaded and waiting, bypass
  // close-to-tray entirely so the close button actually quits the app —
  // electron-updater's autoInstallOnAppQuit then fires on the way out and
  // the user lands on the new version next launch. Without this branch,
  // tray-only users never trigger app.quit() and updates pile up forever.
  mainWindow.on("close", (e) => {
    if (updateDownloaded) {
      setQuitting(true);
      return;
    }
    if (!isQuitting && getSettings().closeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    // Same reasoning as the render-process-gone handler above: the window
    // (and its IPC listeners) are gone, so the hook must not keep running.
    // "closed" only fires on real destruction, never on hide-to-tray (that
    // path calls e.preventDefault() in the "close" handler above), so this
    // never interrupts the close-to-tray flow.
    shutdownGlobalHotkeys();
  });

  return mainWindow;
}
