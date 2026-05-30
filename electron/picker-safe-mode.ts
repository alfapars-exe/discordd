/**
 * electron/picker-safe-mode.ts — Self-healing screen-picker thumbnail safe mode.
 *
 * `desktopCapturer.getSources()` with a non-zero `thumbnailSize` captures a
 * bitmap of every screen + window through the GPU/compositor. On some Windows
 * machines this NATIVELY crashes a process (the GPU child, the renderer, or the
 * main process itself). Three properties make that crash nasty:
 *
 *   - It is a C++ crash, so the JS-level `Promise.race(getSources, timeout)` in
 *     screen-picker.ts cannot rescue it — when the process dies the setTimeout
 *     dies with it. (Field evidence: renderers/app dying ~1 s after
 *     `sources_query_start`, well before the 2500 ms timeout, with no
 *     `sources_query_error` ever emitted.)
 *   - When it takes the MAIN process, it never reaches crash-reporter.ts either
 *     — `render-process-gone` / `child-process-gone` listeners live in main and
 *     die with it, so no `last-crash.json` is written (only a Crashpad .dmp).
 *   - We cannot predict which machine (GPU / driver / protected-window combo)
 *     will crash, so a static "always" or "never" thumbnail policy is wrong.
 *
 * So we detect-and-remember instead, with two independent signals:
 *
 *   1. breadcrumb (survives a MAIN-process crash): a file written to disk
 *      immediately BEFORE a thumbnail getSources call and deleted immediately
 *      after it settles. If the call kills the process the breadcrumb survives;
 *      at next startup `promoteLeftoverBreadcrumb()` finds it and flips the
 *      sticky disabled flag. This is the ONLY signal that survives main dying.
 *
 *   2. in-flight flag (handles render/child crashes where MAIN survives):
 *      crash-reporter.ts checks `isThumbnailCaptureInFlight()` inside its
 *      render-/child-process-gone handlers and calls `disablePickerThumbnails()`
 *      directly.
 *
 * Once disabled, querySources() requests `thumbnailSize { 0, 0 }` (pure
 * enumeration — ids + names, no bitmap capture), so the crashing native path is
 * never exercised again on that machine. Sticky by design: a machine that
 * crashed once will almost certainly crash again. Healthy machines trip neither
 * signal and keep their thumbnailed picker forever.
 *
 * Files (under app.getPath('userData')):
 *   picker-safe-mode.json   { thumbnailsDisabled, reason, at }
 *   picker-thumb-inflight   breadcrumb (timestamp), present only mid-capture
 */

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import path from "path";

// Cached after first disk read so the hot path (querySources) doesn't stat the
// file on every screen-share click. `disablePickerThumbnails` keeps it coherent
// within the session by writing through.
let cachedDisabled: boolean | null = null;

// In-memory only — true between begin/endThumbnailCapture(). Read by
// crash-reporter.ts to attribute a render/GPU crash to the thumbnail capture.
let inFlight = false;

function flagPath(): string {
  return path.join(app.getPath("userData"), "picker-safe-mode.json");
}

function breadcrumbPath(): string {
  return path.join(app.getPath("userData"), "picker-thumb-inflight");
}

/**
 * Whether thumbnail capture is permanently disabled on this machine after a
 * detected screen-picker crash. Cached; defaults to false (capture enabled).
 */
export function arePickerThumbnailsDisabled(): boolean {
  if (cachedDisabled === null) {
    try {
      const p = flagPath();
      cachedDisabled =
        existsSync(p) &&
        (JSON.parse(readFileSync(p, "utf-8")) as { thumbnailsDisabled?: boolean })
          .thumbnailsDisabled === true;
    } catch {
      // Corrupt/unreadable flag file — treat as "not disabled" so a healthy
      // machine isn't punished by a bad read. A real crash re-trips it.
      cachedDisabled = false;
    }
  }
  return cachedDisabled;
}

/**
 * Permanently disable thumbnail capture on this machine. Idempotent and
 * crash-handler-safe (synchronous, swallows its own errors). `reason` is for
 * diagnostics only.
 */
export function disablePickerThumbnails(reason: string): void {
  cachedDisabled = true;
  try {
    const p = flagPath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ thumbnailsDisabled: true, reason, at: new Date().toISOString() }),
      "utf-8",
    );
    console.warn(`[picker-safe-mode] thumbnails disabled: ${reason}`);
  } catch (err) {
    // In-memory cache is still set, so this session stays safe even if the
    // flag doesn't persist; next launch may re-detect via the breadcrumb.
    console.error("[picker-safe-mode] failed to persist disabled flag:", err);
  }
}

/**
 * Mark a thumbnail-capturing getSources as in flight. Writes the breadcrumb
 * (synchronously, so it's on disk before the native call can crash) and sets
 * the in-flight flag. MUST be paired with `endThumbnailCapture()` in a finally.
 * Only call on the NON-safe path — the safe path captures no thumbnails and so
 * cannot crash here.
 */
export function beginThumbnailCapture(): void {
  inFlight = true;
  try {
    const p = breadcrumbPath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, String(Date.now()), "utf-8");
  } catch {
    // Best effort. Losing the breadcrumb only weakens self-healing for a
    // MAIN-process crash; the in-flight flag still covers render/GPU crashes.
  }
}

/** Clear the in-flight flag and delete the breadcrumb. Safe to call always. */
export function endThumbnailCapture(): void {
  inFlight = false;
  try {
    unlinkSync(breadcrumbPath());
  } catch {
    // ENOENT (never written) or a delete race — nothing to clean up.
  }
}

/** True while a thumbnail-capturing getSources is between begin/end. */
export function isThumbnailCaptureInFlight(): boolean {
  return inFlight;
}

/**
 * Startup recovery. A leftover breadcrumb means the PREVIOUS run's thumbnail
 * getSources killed the process before it could be cleared — the definitive
 * signal of a screen-picker crash that survives even a main-process death
 * (which crash-reporter.ts cannot observe). Promote it to the sticky disabled
 * flag and clear it. Call once early in app startup, before the first picker.
 */
export function promoteLeftoverBreadcrumb(): void {
  try {
    if (existsSync(breadcrumbPath())) {
      disablePickerThumbnails(
        "leftover breadcrumb — previous thumbnail getSources crashed the process",
      );
      unlinkSync(breadcrumbPath());
    }
  } catch (err) {
    console.error("[picker-safe-mode] breadcrumb promotion failed:", err);
  }
}
