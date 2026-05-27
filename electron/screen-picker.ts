/**
 * electron/screen-picker.ts — Custom screen-share source picker.
 *
 * Single responsibility: intercept getDisplayMedia() requests and
 * orchestrate a custom picker UI in the renderer:
 *   1. Query desktopCapturer for screens + windows (with thumbnails + app icons)
 *   2. Send sources to renderer via "show-screen-picker"
 *   3. Allow refresh while picker is open via "screen-picker-refresh"
 *   4. Wait for "screen-picker-result" with the chosen id
 *   5. Return only the video source — system audio is captured separately
 *      by audio-capture.ts (process-loopback to avoid voice echo)
 *
 * Source visibility caveats: desktopCapturer can't see windows running in
 * elevated processes (when our app isn't elevated) and may miss some
 * fullscreen DXGI/protected surfaces. The refresh button mitigates the
 * common case of a target window opening after the picker is shown.
 */

import { desktopCapturer, ipcMain, session } from "electron";
import { getMainWindow } from "./window";

type SerializedSource = {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
};

// Hard cap on how long we'll wait for desktopCapturer.getSources. Windows
// builds with many top-level windows (or elevated processes alongside our
// non-elevated app) have been observed to hang this call indefinitely,
// which then locks up the renderer waiting for the picker IPC and
// eventually crashes it. Race with a timeout so a hang surfaces as a
// clean "no sources" instead of a renderer death.
const GET_SOURCES_TIMEOUT_MS = 5000;

async function querySources() {
  // thumbnailSize halved (480×270 → 240×135) — each PNG dataURL was ~200-400
  // KB; on machines with 30+ windows the combined IPC payload ran past 10 MB
  // in a single message and crashed V8 string allocation. 240×135 stays
  // clear enough for picker UX while shrinking IPC ~4×.
  //
  // fetchWindowIcons disabled — icons are another 50-100 KB per source and
  // are the specific surface Electron has crashed on for users with
  // elevated/protected windows (Vanguard, EAC, some banking apps).
  const sourcesPromise = desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 240, height: 135 },
    fetchWindowIcons: false,
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`desktopCapturer.getSources timed out after ${GET_SOURCES_TIMEOUT_MS}ms`)),
      GET_SOURCES_TIMEOUT_MS,
    ),
  );

  return await Promise.race([sourcesPromise, timeoutPromise]);
}

function serialize(s: Awaited<ReturnType<typeof querySources>>[number]): SerializedSource {
  return {
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
  };
}

/**
 * Install the displayMedia request handler on the default session.
 * Call once at app start (after session.defaultSession is available).
 */
export function installScreenPicker(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      let sources = await querySources();
      if (sources.length === 0) {
        callback({});
        return;
      }

      const win = getMainWindow();
      win?.webContents.send("show-screen-picker", sources.map(serialize));

      // Refresh handler — re-queries while picker is open. Lifetime is one
      // getDisplayMedia call; removed in finally below.
      const refreshHandler = async () => {
        try {
          sources = await querySources();
          getMainWindow()?.webContents.send(
            "screen-picker-refresh-result",
            sources.map(serialize),
          );
        } catch (err) {
          console.error("[screen-picker] refresh error:", err);
        }
      };
      ipcMain.on("screen-picker-refresh", refreshHandler);

      try {
        const sourceId = await new Promise<string | null>((resolve) => {
          ipcMain.once("screen-picker-result", (_e, id: string | null) => resolve(id));
        });

        if (sourceId) {
          const selected = sources.find((s) => s.id === sourceId);
          callback(selected ? { video: selected } : {});
        } else {
          callback({});
        }
      } finally {
        ipcMain.off("screen-picker-refresh", refreshHandler);
      }
    } catch (err) {
      console.error("[screen-picker] error:", err);
      callback({});
    }
  });
}

/**
 * Read-only fetch of desktop sources (without showing the custom picker).
 * Used by the legacy "get-desktop-sources" IPC handler.
 */
export async function getSerializedSources(): Promise<{ id: string; name: string; thumbnail: string }[]> {
  const sources = await desktopCapturer.getSources({ types: ["window", "screen"] });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
}
