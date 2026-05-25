/**
 * useDisplayInfo — Native display metrics for the active monitor.
 *
 * Used by the screen-share quality + FPS dropdowns to populate a dynamic
 * "Max" option that resolves to the user's actual monitor capabilities.
 *
 * Two environments:
 *
 *   1. Electron — invokes `electronAPI.getDisplayInfo()` which reads
 *      `screen.getDisplayMatching(window.bounds)` in the main process.
 *      Returns physical pixels (scaleFactor-applied) + native refresh rate.
 *
 *   2. Web (any browser) — falls back to `window.screen.width/height`.
 *      Browsers don't expose refresh rate without the experimental
 *      `getScreenDetails()` Window Management API which requires a user
 *      gesture + permission grant. We return `refreshRate: 0` and let the
 *      callers hide the Max-Hz option entirely on web — there's no
 *      meaningful number to display.
 *
 * The hook is "load once" — it doesn't subscribe to monitor changes. If
 * the user drags HiChat! to a different monitor mid-session, they'll
 * keep the metrics from the original one until next reload. This is
 * intentional: re-querying on every `display-metrics-changed` would
 * either invalidate already-chosen quality (UX surprise) or be ignored
 * (no value). Reload is a rare path that's worth keeping simple.
 */

import { useEffect, useState } from "react";

export type DisplayInfo = {
  width: number;
  height: number;
  /**
   * Native refresh rate in Hz. `0` means "platform does not report it" —
   * treat as a signal to hide the dynamic Max-Hz option rather than as a
   * value to display.
   */
  refreshRate: number;
  /**
   * Number of monitors attached. Web fallback returns 1 (we can't tell
   * without the Window Management API + permission grant). Used by
   * diagnostic telemetry to correlate multi-monitor setups with screen-
   * share failures.
   */
  monitorCount: number;
};

export function useDisplayInfo(): DisplayInfo | null {
  const [info, setInfo] = useState<DisplayInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (window.electronAPI?.getDisplayInfo) {
      window.electronAPI
        .getDisplayInfo()
        .then((d) => {
          if (cancelled) return;
          setInfo({
            width: d.width,
            height: d.height,
            refreshRate: d.refreshRate,
            monitorCount: d.monitorCount,
          });
        })
        .catch(() => {
          // IPC failed for some reason — fall back to browser screen API
          // so the rest of the UI keeps working.
          if (cancelled) return;
          setInfo({
            width: window.screen.width,
            height: window.screen.height,
            refreshRate: 0,
            monitorCount: 1,
          });
        });
    } else {
      // Web (non-Electron) — browser API only gives logical (DPI-divided) px
      // and no refresh-rate info. Both are fine: web users rarely have
      // monitors above 1440p in this audience, and hiding the Max-Hz option
      // is the right behaviour on web anyway.
      setInfo({
        width: window.screen.width,
        height: window.screen.height,
        refreshRate: 0,
        monitorCount: 1,
      });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}
