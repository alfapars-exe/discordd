import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle } from "electron";

type ActionSurface = "actions" | "notification-actions" | "chat-actions";
type ActionWindowOptions = {
  surface: ActionSurface;
  width: number;
  height: number;
  parent: BrowserWindow;
  preload: string;
  development: boolean;
  regions: Rectangle[];
};
type ActionWindowOperations = {
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  created: (window: BrowserWindow) => void;
  closed: (window: BrowserWindow) => void;
  failed: (window: BrowserWindow, reason: "shape" | "load" | "crash") => void;
};

/** The three non-focusable overlay action surfaces share one native setup policy. */
export function createOverlayActionWindow(options: ActionWindowOptions, operations: ActionWindowOperations): BrowserWindow | null {
  const window = operations.createWindow({
    width: options.width, height: options.height, frame: false, transparent: true,
    resizable: false, alwaysOnTop: true, focusable: false, skipTaskbar: true,
    hasShadow: false, show: false, parent: options.parent,
    webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  operations.created(window);
  try {
    window.setShape(options.regions);
  } catch {
    operations.failed(window, "shape");
    return null;
  }
  window.setAlwaysOnTop(true, "floating");
  let closed = false;
  const crashed = () => { if (!closed) operations.failed(window, "crash"); };
  const onClosed = () => {
    if (closed) return;
    closed = true;
    window.webContents.removeListener("render-process-gone", crashed);
    window.removeListener("closed", onClosed);
    operations.closed(window);
  };
  window.webContents.on("render-process-gone", crashed);
  window.on("closed", onClosed);
  const base = options.development ? "http://localhost:3030" : "app://hichat";
  void window.loadURL(`${base}/overlay.html?surface=${options.surface}`).catch(() => { if (!closed) operations.failed(window, "load"); });
  return window;
}
