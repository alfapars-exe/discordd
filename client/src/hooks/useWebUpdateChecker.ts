/**
 * useWebUpdateChecker — polls /api/version and reports whether the running
 * server has been redeployed since the user's tab loaded.
 *
 * The server returns a UUID generated once per process (startupID). We
 * capture the value from the very first poll as a baseline, then on every
 * later poll check whether it changed. If it did, the binary or the embedded
 * React bundle has been replaced and the user should reload to pick up the
 * new code.
 *
 * Polling cadence: 60s while visible, paused while hidden (no point polling
 * a tab nobody's looking at). Runs an immediate check on visibilitychange
 * back to "visible" so users who left the tab open overnight see the banner
 * the moment they look at it again.
 *
 * Distinct from useUpdateChecker, which handles the Electron auto-updater.
 */

import { useEffect, useRef, useState } from "react";
import { apiClient } from "../api/client";

const POLL_INTERVAL_MS = 60_000;

export function useWebUpdateChecker(): boolean {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const baselineRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function check() {
      if (cancelled) return;
      try {
        const res = await apiClient<{ version: string }>("/version");
        if (cancelled) return;
        if (!res.success || !res.data?.version) return;
        const v = res.data.version;
        if (baselineRef.current === null) {
          baselineRef.current = v;
        } else if (v !== baselineRef.current) {
          setUpdateAvailable(true);
        }
      } catch {
        // Network blip — try again on the next tick.
      }
    }

    function schedule() {
      window.clearTimeout(timer);
      // Don't even schedule a tick while the tab is hidden — wakeup is
      // handled by the visibilitychange listener below. This also prevents
      // a race where the timer fires within milliseconds of an onVisibility
      // poll and two concurrent check() calls each see baselineRef === null
      // and overwrite the baseline.
      if (document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        check();
        schedule();
      }, POLL_INTERVAL_MS);
    }

    function onVisibility() {
      if (document.visibilityState === "visible") {
        check();
        schedule();
      }
    }

    check();
    schedule();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return updateAvailable;
}
