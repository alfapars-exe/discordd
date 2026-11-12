/** Background update checks must never delay the main window or session restore. */
import { app, Notification } from "electron";
import { autoUpdater } from "electron-updater";
import path from "path";
import { getMainWindow, setUpdateDownloaded } from "./window";
import { setTrayUpdateReady } from "./tray";

let prelaunchChecked = false;
let runtimeCheckInterval: ReturnType<typeof setInterval> | null = null;

/**
 * How often we re-poll GitHub Releases for a newer version while the app
 * is running.
 *
 * Audit 2026-05-27: bumped from 60s → 5min to stay within GitHub's anonymous
 * API budget (60 requests/hour per IP). At 60s a single client used the
 * whole budget; multiple clients on the same NAT (corp office, household)
 * silently hit rate-limit and missed critical security updates because the
 * `.catch(() => undefined)` in setupAutoUpdater swallowed the 429.
 *
 * At 5min:
 *   - 1 client = 12 req/hour (well under 60)
 *   - 5 clients on same NAT = 60 req/hour (exactly the budget — acceptable)
 *   - Update visibility delay: max ~5min after release publish
 *
 * Long-term: route release-check through our own backend (server-side cache
 * with 1h TTL → fans out to unlimited clients without burning GitHub quota).
 */
const RUNTIME_CHECK_MS = 5 * 60 * 1000;

/** Has the pre-launch splash already run an update check? Used to deduplicate. */
export function wasPrelaunchChecked(): boolean {
  return prelaunchChecked;
}

/**
 * Wire up event-driven update notifications while the app is running.
 *
 * autoDownload=true so the .exe streams in the background as soon as a
 * new release is detected; autoInstallOnAppQuit=true so the installer
 * fires automatically on next quit if the user never clicks "Restart now".
 * The renderer-side useUpdateChecker hook listens for the IPC events we
 * forward here and surfaces an UpdateBanner with a restart button.
 *
 * Errors (network down, GitHub rate-limit, transient release-feed parse
 * failures) are forwarded as `update-error` but the renderer treats them
 * as silent — no banner, just a console warning. We don't want the app to
 * pester the user every five minutes about a hiccup.
 */
export function setupAutoUpdater(): void {
  if (!app.isPackaged) return;
  prelaunchChecked = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    getMainWindow()?.webContents.send("update-available", info);
  });
  autoUpdater.on("download-progress", (progress) => {
    getMainWindow()?.webContents.send("update-progress", progress);
  });
  autoUpdater.on("update-downloaded", (info) => {
    // Renderer banner — visible only when a window is open. Backed up by
    // the next three signals so tray-only users never miss the update.
    getMainWindow()?.webContents.send("update-downloaded", info);

    // Tray menu entry — surfaces "Restart and install" so users who keep
    // the app tray-resident can apply the update without ever opening
    // the renderer.
    setTrayUpdateReady(info.version);

    // Close-button semantics swap — the next X click will quit() instead
    // of going to tray, letting autoInstallOnAppQuit actually fire. The
    // alternative (autoInstallOnAppQuit waiting for a quit that never
    // comes) is exactly why close-to-tray users sat on stale versions.
    setUpdateDownloaded();

    // Native Windows toast — fires once per update, even when the window
    // is minimised to tray. Click invokes quitAndInstall directly.
    try {
      const notification = new Notification({
        title: "HiChat! — Güncelleme Hazır",
        body: `v${info.version} indirildi. Yeniden başlatmak için tıklayın.`,
        icon: path.join(__dirname, "../icons/hlogo.png"),
      });
      notification.on("click", () => {
        autoUpdater.quitAndInstall(true, true);
      });
      notification.show();
    } catch (err) {
      // OS denied notifications, or running without a desktop session —
      // tray entry + renderer banner still cover the path.
      console.warn("[auto-updater] notification failed:", err);
    }
  });
  autoUpdater.on("error", (err) => {
    getMainWindow()?.webContents.send("update-error", err.message);
  });

  // Initial check + recurring poll. Both swallow errors so a temporary
  // network blip doesn't crash the main process.
  autoUpdater.checkForUpdates().catch(() => undefined);
  if (runtimeCheckInterval) clearInterval(runtimeCheckInterval);
  runtimeCheckInterval = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => undefined);
  }, RUNTIME_CHECK_MS);
}
