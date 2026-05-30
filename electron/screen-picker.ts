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
import {
  arePickerThumbnailsDisabled,
  beginThumbnailCapture,
  endThumbnailCapture,
} from "./picker-safe-mode";

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
//
// NOTE: this race only covers a *hang*. A native (C++) crash inside getSources
// kills the process outright — the setTimeout dies with it, so no timeout/error
// is ever emitted (the documented "app vanishes ~1 s after sources_query_start"
// signature). That failure mode is handled separately by picker-safe-mode.ts:
// a breadcrumb around the call flips a sticky no-thumbnail mode on next launch.
//
// Track P → Track Q (v2.11.94): lowered 5000 → 2500. Field reports show
// renderers dying ~2 s after screen_share_attempt in CS2 sessions even
// before the picker UI surfaces — long enough for getDisplayMedia to be
// in flight but with no event-loop tick in the renderer. 2500 ms still
// fits a healthy Windows desktop with 30+ windows (typical: 200–400 ms)
// while shortening the danger window where the renderer can die waiting.
const GET_SOURCES_TIMEOUT_MS = 2500;

// Helper: emit a structured diagnostic event to the renderer so it can
// forward the row to /client-log. Best-effort — missing main window or
// failed send are silently swallowed; diagnostics MUST NOT break the
// real picker flow.
function emitPickerDiagnostic(phase: string, extra: Record<string, unknown> = {}): void {
  try {
    getMainWindow()?.webContents.send("screen-picker-diagnostic", {
      phase,
      timestamp: Date.now(),
      ...extra,
    });
  } catch {
    /* swallow — diagnostic only */
  }
}

async function querySources() {
  // thumbnailSize halved (480×270 → 240×135) — each PNG dataURL was ~200-400
  // KB; on machines with 30+ windows the combined IPC payload ran past 10 MB
  // in a single message and crashed V8 string allocation. 240×135 stays
  // clear enough for picker UX while shrinking IPC ~4×.
  //
  // fetchWindowIcons disabled — icons are another 50-100 KB per source and
  // are the specific surface Electron has crashed on for users with
  // elevated/protected windows (Vanguard, EAC, some banking apps).
  const queryStart = Date.now();

  // Safe mode (set after a prior screen-picker crash on this machine) skips
  // thumbnail bitmap capture entirely: `{ 0, 0 }` enumerates ids + names only
  // and never touches the GPU/compositor path that natively crashes. Healthy
  // machines keep full thumbnails. See picker-safe-mode.ts.
  const safe = arePickerThumbnailsDisabled();
  emitPickerDiagnostic("sources_query_start", { thumbnails: !safe });

  // Breadcrumb the crash-prone call so a process death during it self-heals on
  // next launch. Only on the thumbnail path — the safe path can't crash here.
  if (!safe) beginThumbnailCapture();

  const sourcesPromise = desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: safe ? { width: 0, height: 0 } : { width: 240, height: 135 },
    fetchWindowIcons: false,
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`desktopCapturer.getSources timed out after ${GET_SOURCES_TIMEOUT_MS}ms`)),
      GET_SOURCES_TIMEOUT_MS,
    ),
  );

  try {
    const sources = await Promise.race([sourcesPromise, timeoutPromise]);
    emitPickerDiagnostic("sources_query_done", {
      durationMs: Date.now() - queryStart,
      sourceCount: sources.length,
      thumbnails: !safe,
    });
    return sources;
  } catch (err) {
    emitPickerDiagnostic("sources_query_error", {
      durationMs: Date.now() - queryStart,
      error: err instanceof Error ? err.message : String(err),
      timedOut: err instanceof Error && /timed out/.test(err.message),
    });
    throw err;
  } finally {
    // Clears the breadcrumb + in-flight flag. A no-op on the safe path.
    if (!safe) endThumbnailCapture();
  }
}

function serialize(s: Awaited<ReturnType<typeof querySources>>[number]): SerializedSource {
  return {
    id: s.id,
    name: s.name,
    // Empty in safe mode (thumbnailSize {0,0}) — send "" so the renderer draws a
    // placeholder instead of a broken <img>. isEmpty() avoids the
    // "data:image/png;base64," stub toDataURL() would return for an empty image.
    thumbnail: s.thumbnail.isEmpty() ? "" : s.thumbnail.toDataURL(),
    appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
  };
}

/**
 * Install the displayMedia request handler on the default session.
 * Call once at app start (after session.defaultSession is available).
 */
export function installScreenPicker(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    // Diagnostic — the renderer's screen_share_attempt log lands BEFORE this
    // runs; pairing the two rows tells us whether getDisplayMedia even made
    // it into the handler before the renderer died. Missing = crash in the
    // IPC queue (the Windows-elevated-process hang path).
    const handlerStart = Date.now();
    emitPickerDiagnostic("request_handler_start");

    try {
      let sources = await querySources();
      if (sources.length === 0) {
        emitPickerDiagnostic("no_sources", { msSinceHandlerStart: Date.now() - handlerStart });
        callback({});
        return;
      }

      const win = getMainWindow();
      win?.webContents.send("show-screen-picker", sources.map(serialize));
      emitPickerDiagnostic("picker_shown", {
        msSinceHandlerStart: Date.now() - handlerStart,
        sourceCount: sources.length,
      });

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
          emitPickerDiagnostic("result_received", {
            msSinceHandlerStart: Date.now() - handlerStart,
            picked: !!selected,
            sourceKind: selected?.id?.startsWith("screen:") ? "screen" : (selected ? "window" : "none"),
          });
          callback(selected ? { video: selected } : {});
        } else {
          emitPickerDiagnostic("result_cancelled", {
            msSinceHandlerStart: Date.now() - handlerStart,
          });
          callback({});
        }
      } finally {
        ipcMain.off("screen-picker-refresh", refreshHandler);
      }
    } catch (err) {
      console.error("[screen-picker] error:", err);
      emitPickerDiagnostic("handler_error", {
        msSinceHandlerStart: Date.now() - handlerStart,
        error: err instanceof Error ? err.message : String(err),
      });
      callback({});
    }
  });
}

/**
 * Read-only fetch of desktop sources (without showing the custom picker).
 * Used by the legacy "get-desktop-sources" IPC handler.
 */
export async function getSerializedSources(): Promise<{ id: string; name: string; thumbnail: string }[]> {
  // Same crash surface as querySources: the default thumbnailSize captures a
  // bitmap per source. Honor the machine's safe-mode flag so this legacy path
  // can't reintroduce the native getSources crash on an already-flagged machine.
  const safe = arePickerThumbnailsDisabled();
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: safe ? { width: 0, height: 0 } : { width: 150, height: 150 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.isEmpty() ? "" : s.thumbnail.toDataURL(),
  }));
}
