/**
 * electron/tray.ts — System tray icon, click handler, context menu.
 *
 * Single responsibility: manage the Tray instance + context menu + tooltip.
 * The menu is rebuilt on demand so the auto-updater can surface a
 * "Restart and install update" entry at the top when an installer is
 * ready — tray-only users would otherwise never see the renderer's
 * UpdateBanner and could sit on a stale version indefinitely.
 */

import { app, Menu, MenuItemConstructorOptions, nativeImage, Tray } from "electron";
import { autoUpdater } from "electron-updater";
import path from "path";
import { getMainWindow, setQuitting } from "./window";

let tray: Tray | null = null;
let updateReadyVersion: string | null = null;

function buildContextMenu(): Menu {
  const entries: MenuItemConstructorOptions[] = [];

  // Update entry sits at the top in bold when available — this is the
  // only signal a tray-only user gets that a newer version is downloaded
  // and waiting (the renderer banner only renders inside the open window).
  if (updateReadyVersion) {
    entries.push({
      label: `🔄 v${updateReadyVersion} — Yeniden Başlat ve Güncelle`,
      click: () => {
        // quitAndInstall(isSilent, isForceRunAfter) — silent install, then
        // relaunch the app. setQuitting unblocks the close-to-tray gate so
        // the running window can shut down cleanly.
        setQuitting(true);
        autoUpdater.quitAndInstall(true, true);
      },
    });
    entries.push({ type: "separator" });
  }

  entries.push({ label: "Göster", click: () => getMainWindow()?.show() });
  entries.push({
    label: "Çıkış",
    click: () => {
      setQuitting(true);
      app.quit();
    },
  });

  return Menu.buildFromTemplate(entries);
}

export function createTray(): void {
  // Single canonical app logo across platforms. Electron resizes the
  // PNG for the platform's tray density (16/22 on Linux/macOS, 256 on
  // Windows) so we no longer need separate small/large variants.
  const iconPath = path.join(__dirname, "../icons", "hlogo.png");
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("HiChat!");

  tray.on("click", () => getMainWindow()?.show());
  tray.setContextMenu(buildContextMenu());
}

/** Update tooltip (used by badge module for unread count). */
export function setTrayTooltip(text: string): void {
  tray?.setToolTip(text);
}

/**
 * Called by auto-updater when an installer is downloaded. Adds a
 * "Restart and install" entry to the tray context menu so tray-only
 * users have a visible, one-click path to apply the update.
 */
export function setTrayUpdateReady(version: string): void {
  updateReadyVersion = version;
  if (tray) {
    tray.setContextMenu(buildContextMenu());
    tray.setToolTip(`HiChat! — v${version} hazır, yeniden başlat`);
  }
}
