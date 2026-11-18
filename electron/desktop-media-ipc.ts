import type { BrowserWindow, Display, IpcMain, IpcMainInvokeEvent, Rectangle } from "electron";

type DesktopDisplay = Pick<Display, "size" | "scaleFactor" | "displayFrequency">;
type DesktopMediaOperations = {
  trusted: (event: IpcMainInvokeEvent) => void;
  getSerializedSources: typeof import("./screen-picker").getSerializedSources;
  getMainWindow: () => Pick<BrowserWindow, "getBounds"> | null;
  screen: {
    getDisplayMatching: (bounds: Rectangle) => DesktopDisplay;
    getPrimaryDisplay: () => DesktopDisplay;
    getAllDisplays: () => DesktopDisplay[];
  };
};

/** Legacy source enumeration and current-window display metrics retain their public contracts. */
export function registerDesktopMediaIPC(ipc: Pick<IpcMain, "handle">, operations: DesktopMediaOperations): void {
  ipc.handle("get-desktop-sources", event => { operations.trusted(event); return operations.getSerializedSources(); });
  ipc.handle("get-display-info", () => {
    const window = operations.getMainWindow();
    const display = window
      ? operations.screen.getDisplayMatching(window.getBounds())
      : operations.screen.getPrimaryDisplay();
    // Electron size is in logical pixels; capture limits require physical pixels.
    return {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
      refreshRate: display.displayFrequency,
      scaleFactor: display.scaleFactor,
      monitorCount: operations.screen.getAllDisplays().length,
    };
  });
}
