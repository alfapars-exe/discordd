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
  // Single canonical app logo across platforms. Electron resizes the
  // PNG for the platform's tray density (16/22 on Linux/macOS, 256 on
  // Windows) so we no longer need separate small/large variants.
  const iconPath = path.join(__dirname, "../icons", "hlogo.png");
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
