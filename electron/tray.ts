/**
 * electron/tray.ts — System tray icon, click handler, context menu.
 *
 * Single responsibility: manage the Tray instance + tooltip mutation
 * (used for unread-count display). Exposes setTrayTooltip so the badge
 * module can drive the tooltip without owning the tray ref.
 */

import { app, Menu, nativeImage, Tray } from "electron";
import path from "path";
import { getMainWindow, setQuitting } from "./window";

let tray: Tray | null = null;

export function createTray(): void {
  // macOS menu bar wants a small icon; everywhere else uses a 256x256 png.
  const iconName = process.platform === "darwin" ? "tray-icon-22.png" : "mqvi-icon-256x256.png";
  const iconPath = path.join(__dirname, "../icons", iconName);
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("HiChat!");

  tray.on("click", () => getMainWindow()?.show());

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show", click: () => getMainWindow()?.show() },
      {
        label: "Quit",
        click: () => {
          setQuitting(true);
          app.quit();
        },
      },
    ]),
  );
}

/** Update tooltip (used by badge module for unread count). */
export function setTrayTooltip(text: string): void {
  tray?.setToolTip(text);
}
