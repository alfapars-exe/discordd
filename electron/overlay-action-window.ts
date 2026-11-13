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
  failed: (window: BrowserWindow, reason: "shape" | "load") => void;
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
  window.on("closed", () => operations.closed(window));
  const base = options.development ? "http://localhost:3030" : "app://hichat";
  void window.loadURL(`${base}/overlay.html?surface=${options.surface}`).catch(() => operations.failed(window, "load"));
  return window;
}
