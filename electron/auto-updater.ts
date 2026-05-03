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

import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { readFileSync } from "fs";
import path from "path";

let prelaunchChecked = false;
let splashWindow: BrowserWindow | null = null;

/** Has the pre-launch splash already run an update check? Used to deduplicate. */
export function wasPrelaunchChecked(): boolean {
  return prelaunchChecked;
}

/**
 * Wire up event-driven updates between launches.
 * Currently no-op — see file header for context.
 */
export function setupAutoUpdater(): void {
  return;
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
    icon: path.join(__dirname, "../icons/mqvi-icon.ico"),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Inline HTML — splash UI. Logo injected via DOM API after load to avoid
  // base64 URL-encoding issues. setLogo uses createElement (not innerHTML)
  // so even if the data-url were somehow attacker-controlled it could not
  // inject markup.
  const html = `<!DOCTYPE html>
<html>
<head>
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
    const logoPath = path.join(__dirname, "../icons/mqvi-icon-128x128.png");
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
