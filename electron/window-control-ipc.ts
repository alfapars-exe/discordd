import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, NativeImage } from "electron";

type WindowOperations = {
  trusted: (event: IpcMainInvokeEvent) => void;
  getMainWindow: () => Pick<BrowserWindow, "setOverlayIcon" | "isFocused" | "flashFrame" | "minimize" | "isMaximized" | "unmaximize" | "maximize" | "close"> | null;
  createBadgeImage: (url: string) => NativeImage;
  setTrayTooltip: (text: string) => void;
  assertString: (value: unknown, name: string, max: number) => asserts value is string;
  assertFiniteNumber: (value: unknown, name: string, min: number, max: number) => asserts value is number;
};
const MAX_BADGE_COUNT = 99999;
const MAX_BADGE_ICON_BYTES = 256 * 1024;

export function registerWindowControlIPC(ipc: Pick<IpcMain, "handle">, operations: WindowOperations): void {
  const { getMainWindow, setTrayTooltip } = operations;
  const assertString: WindowOperations["assertString"] = operations.assertString;
  const assertFiniteNumber: WindowOperations["assertFiniteNumber"] = operations.assertFiniteNumber;
  ipc.handle(
    "set-badge-count",
    (event: IpcMainInvokeEvent, count: unknown, iconDataURL: unknown) => {
      operations.trusted(event);
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
          operations.createBadgeImage(iconDataURL),
          `${count} unread`,
        );
      }
      setTrayTooltip(count > 0 ? `HiChat! (${count})` : "HiChat!");
    },
  );

  ipc.handle("flash-frame", event => {
    operations.trusted(event);
    const win = getMainWindow();
    if (win && !win.isFocused()) win.flashFrame(true);
  });

  // ─── Custom titlebar window controls ─────────────────────────────
  ipc.handle("minimize-window", event => { operations.trusted(event); getMainWindow()?.minimize(); });
  ipc.handle("maximize-window", event => {
    operations.trusted(event);
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipc.handle("close-window", event => { operations.trusted(event); getMainWindow()?.close(); });

}
