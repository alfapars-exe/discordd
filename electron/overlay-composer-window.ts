import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle } from "electron";

type ComposerOptions = { bounds: Rectangle; parent: BrowserWindow; preload: string; development: boolean };
type ComposerOperations = {
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  created: (window: BrowserWindow) => void;
  ready: (window: BrowserWindow) => void;
  closed: (window: BrowserWindow) => void;
  retire: (window: BrowserWindow, reason: "navigation" | "crash" | "load") => void;
};

/** Own one focused composer document; grants and snapshot data stay in its caller. */
export function createOverlayComposerWindow(options: ComposerOptions, operations: ComposerOperations): BrowserWindow {
  const window = operations.createWindow({
    ...options.bounds, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, focusable: true, skipTaskbar: true, hasShadow: true,
    show: false, parent: options.parent,
    webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  operations.created(window);
  let loaded = false, closed = false;
  const ready = () => {
    if (closed) return;
    loaded = true;
    operations.ready(window);
  };
  const navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (!closed && loaded && mainFrame && !inPlace) operations.retire(window, "navigation");
  };
  const crashed = () => { if (!closed) operations.retire(window, "crash"); };
  const onClosed = () => {
    if (closed) return;
    closed = true;
    window.webContents.removeListener("did-start-navigation", navigate);
    window.webContents.removeListener("render-process-gone", crashed);
    window.webContents.removeListener("did-finish-load", ready);
    window.removeListener("closed", onClosed);
    operations.closed(window);
  };
  window.setAlwaysOnTop(true, "floating");
  window.webContents.on("did-start-navigation", navigate);
  window.webContents.on("render-process-gone", crashed);
  window.on("closed", onClosed);
  const base = options.development ? "http://localhost:3030" : "app://hichat";
  void window.loadURL(`${base}/overlay.html?surface=chat-composer`).catch(() => {
    if (!closed) operations.retire(window, "load");
  });
  if (!closed) {
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", ready);
    else ready();
  }
  return window;
}
