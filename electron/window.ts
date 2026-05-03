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

import { app, BrowserWindow, Menu, screen } from "electron";
import path from "path";
import { getSettings, getWindowBounds, saveWindowBounds, WindowBounds } from "./settings";

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
    icon: path.join(__dirname, "../icons/mqvi-icon.ico"),
    transparent: isTransparent,
    ...(isTransparent ? {} : { backgroundColor: "#111111" }),
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
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

  // F12 toggles DevTools in production too — useful for user-side debugging
  mainWindow.webContents.on("before-input-event", (_e, input) => {
    if (input.key === "F12") mainWindow?.webContents.toggleDevTools();
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
