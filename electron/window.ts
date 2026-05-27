/**
 * electron/window.ts — Main BrowserWindow lifecycle.
 *
 * Single responsibility: create the main window, persist its bounds,
 * and expose a reference for other modules. Close-to-tray, F12 devtools,
 * and ready-to-show flicker prevention live here.
 *
 * Does NOT register IPC. Does NOT touch tray/audio/PTT — those modules
 * import `getMainWindow()` when they need to send events to the renderer.
 */

import { app, BrowserWindow, Menu, screen, shell } from "electron";
import path from "path";
import { getSettings, getWindowBounds, saveWindowBounds, WindowBounds } from "./settings";

// Origins the renderer is allowed to navigate to in-place. Anything else
// (an external link in a message, a phishing redirect, a misconfigured
// invite URL) is opened in the user's default browser instead of being
// rendered inside the chromeless Electron window — where the URL bar is
// hidden and a malicious site can convincingly impersonate the app.
const allowedNavigationOrigins: ReadonlyArray<string> = [
  // Production bundle loads from disk; preserves SPA history navigation.
  "file://",
  // Local dev server (electron:dev runs Vite on 3030).
  "http://localhost:3030",
];

function isInternalNavigation(target: string): boolean {
  return allowedNavigationOrigins.some((o) => target.startsWith(o));
}

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

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

  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL("http://localhost:3030");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../client/dist/index.html"));
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

  // Close-to-tray: hide instead of quit unless tray Quit was clicked
  mainWindow.on("close", (e) => {
    if (!isQuitting && getSettings().closeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}
