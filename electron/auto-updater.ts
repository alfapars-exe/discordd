/**
 * electron/auto-updater.ts — Pre-launch update splash + electron-updater hooks.
 *
 * Single responsibility: own the splash window UX and electron-updater
 * orchestration. Renderer-facing IPC (check/download/install/wasChecked)
 * lives in ipc-handlers.ts and reads `wasPrelaunchChecked()` from here.
 *
 * The `setupAutoUpdater()` body is currently a no-op — release feed not
 * yet pointed at our repo (was inherited from the HiChat fork). When ready,
 * register `autoUpdater.on("update-available" | "download-progress" | ...)`
 * inside `setupAutoUpdater()`. The IPC handlers + splash flow already work
 * without it — they just won't get push notifications between launches.
 */

import { app, BrowserWindow, Notification } from "electron";
import { autoUpdater } from "electron-updater";
import { readFileSync } from "fs";
import path from "path";
import { getMainWindow, setUpdateDownloaded } from "./window";
import { setTrayUpdateReady } from "./tray";

let prelaunchChecked = false;
let splashWindow: BrowserWindow | null = null;
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

function createSplashWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 380,
    height: 180,
    frame: false,
    resizable: false,
    center: true,
    transparent: false,
    alwaysOnTop: true,
    backgroundColor: "#111111",
    icon: path.join(__dirname, "../icons/hlogo.png"),
    // Same fix as window.ts:107 — without this the frame-less splash still
    // has a WM-level title that Alt+Tab/taskbar tooltips/screen readers
    // query, defaulting to "Electron" until the HTML <title> tag below
    // attaches to the DOM.
    title: "HiChat!",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Inline HTML — splash UI. Logo injected via DOM API after load to avoid
  // base64 URL-encoding issues. setLogo uses createElement (not innerHTML)
  // so even if the data-url were somehow attacker-controlled it could not
  // inject markup.
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>HiChat!</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      background: #111111; color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      height: 100vh; user-select: none;
      -webkit-app-region: drag;
    }
    .logo { width: 64px; height: 64px; margin-bottom: 16px; }
    .logo-text { font-size: 32px; font-weight: 800; color: #3b82f6; margin-bottom: 16px; }
    .status { font-size: 14px; color: #888; }
    .progress-wrap {
      width: 240px; height: 4px; background: #222222;
      border-radius: 2px; margin-top: 12px; overflow: hidden;
    }
    .progress-bar {
      height: 100%; width: 0%; background: #3b82f6;
      border-radius: 2px; transition: width 0.3s ease;
    }
  </style>
</head>
<body>
  <div id="logo-container"></div>
  <div class="status" id="status">Checking for updates...</div>
  <div class="progress-wrap"><div class="progress-bar" id="bar"></div></div>
  <script>
    window.setStatus = (text) => { document.getElementById('status').textContent = text; };
    window.setProgress = (pct) => { document.getElementById('bar').style.width = pct + '%'; };
    window.setLogo = (dataUrl) => {
      const c = document.getElementById('logo-container');
      while (c.firstChild) c.removeChild(c.firstChild);
      if (dataUrl) {
        const img = document.createElement('img');
        img.className = 'logo';
        img.alt = 'HiChat!';
        img.src = dataUrl;
        c.appendChild(img);
      } else {
        const div = document.createElement('div');
        div.className = 'logo-text';
        div.textContent = 'HiChat!';
        c.appendChild(div);
      }
    };
  </script>
</body>
</html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  // Inject logo as data URL after load — avoids URL-encoding issues with base64 in source.
  win.webContents.once("did-finish-load", () => {
    const logoPath = path.join(__dirname, "../icons/hlogo.png");
    try {
      const buf = readFileSync(logoPath);
      const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
      win.webContents.executeJavaScript(`window.setLogo(${JSON.stringify(dataUrl)})`);
    } catch {
      win.webContents.executeJavaScript(`window.setLogo(null)`);
    }
  });

  return win;
}

/**
 * Show splash, check for updates, download if available, then launch app.
 * Returns true if an update is downloading (caller should NOT createWindow —
 * quitAndInstall will fire and restart). False otherwise (proceed to launch).
 *
 * Skipped in dev mode.
 */
export async function checkForUpdateBeforeLaunch(): Promise<boolean> {
  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
  if (isDev) return false;

  splashWindow = createSplashWindow();

  try {
    autoUpdater.autoDownload = false;
    const result = await autoUpdater.checkForUpdates();
    prelaunchChecked = true;

    if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
      splashWindow.close();
      splashWindow = null;
      return false;
    }

    const newVersion = result.updateInfo.version;
    splashWindow.webContents.executeJavaScript(`window.setStatus('Downloading v${newVersion}...')`);

    autoUpdater.on("download-progress", (progress) => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents.executeJavaScript(`window.setProgress(${Math.round(progress.percent)})`);
      }
    });

    autoUpdater.on("update-downloaded", () => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents.executeJavaScript(
          `window.setStatus('Installing...'); window.setProgress(100)`,
        );
      }
      // Brief delay so the user sees "Installing..." before restart
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 1000);
    });

    await autoUpdater.downloadUpdate();
    return true;
  } catch (err) {
    prelaunchChecked = true;
    console.error("[auto-updater] pre-launch check failed:", err);
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    return false;
  }
}
