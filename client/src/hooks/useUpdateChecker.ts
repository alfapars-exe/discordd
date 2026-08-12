/**
 * useUpdateChecker — Electron auto-update hook.
 *
 * Flow:
 * 1. Update check happens at splash screen (main process)
 * 2. If found at runtime, downloads in background (autoDownload=true)
 * 3. Shows "Restart" banner when download completes
 * 4. User clicks restart or update installs on next app quit
 *
 * No-op in web mode.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { isElectron } from "../utils/constants";

/** Re-show the banner this many ms after user dismisses it. */
const DISMISS_SNOOZE_MS = 30 * 60 * 1000;

type UpdateStatus =
  | "idle"
  | "downloading"
  | "ready";

type UpdateInfo = {
  version: string;
};

type UpdateChecker = {
  status: UpdateStatus;
  update: UpdateInfo | null;
  progress: number;
  restartAndInstall: () => void;
  dismiss: () => void;
};

export function useUpdateChecker(): UpdateChecker {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);

  // Holds the downloaded UpdateInfo across a dismiss → snooze → re-show
  // cycle. Without this, dismissing the banner cleared the React state
  // and the snooze timer had nothing to restore.
  const downloadedUpdateRef = useRef<UpdateInfo | null>(null);
  const snoozeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isElectron()) return;

    const api = window.electronAPI!;

    api.onUpdateAvailable((info) => {
      setUpdate({ version: info.version });
      setStatus("downloading");
      setProgress(0);
    });

    api.onUpdateProgress((progressInfo) => {
      setProgress(Math.round(progressInfo.percent));
    });

    api.onUpdateDownloaded((info) => {
      const downloaded: UpdateInfo = { version: info?.version ?? "" };
      downloadedUpdateRef.current = downloaded;
      setUpdate(downloaded);
      setProgress(100);
      setStatus("ready");
    });

    api.onUpdateError((message) => {
      // Network errors (tunnel failures, no internet) are expected —
      // don't show a banner, just log for debugging.
      console.warn("[updater] Update check failed:", message);
      // A failed DOWNLOAD must also clear the "downloading" banner, or it
      // sits at "Güncelleme indiriliyor N%" forever — the next successful
      // periodic check restarts the flow cleanly. A finished download
      // (status "ready", or a snoozed ready state held in
      // downloadedUpdateRef) is preserved: the installer is on disk and a
      // later check hiccup shouldn't hide the restart prompt.
      if (!downloadedUpdateRef.current) {
        setStatus((s) => (s === "downloading" ? "idle" : s));
        setUpdate(null);
        setProgress(0);
      }
    });

    // Listeners persist for app lifetime — no cleanup needed
  }, []);

  const restartAndInstall = useCallback(() => {
    if (!isElectron()) return;
    window.electronAPI!.installUpdate();
  }, []);

  // Snooze banner for DISMISS_SNOOZE_MS, then re-show. The downloaded
  // installer is still sitting on disk — we just stopped nagging for
  // half an hour. Without the snooze, a single dismiss meant the user
  // never saw the prompt again until the next app launch, which for
  // tray-resident users effectively meant "never".
  const dismiss = useCallback(() => {
    setStatus("idle");
    if (snoozeTimerRef.current) clearTimeout(snoozeTimerRef.current);
    snoozeTimerRef.current = setTimeout(() => {
      if (downloadedUpdateRef.current) {
        setUpdate(downloadedUpdateRef.current);
        setProgress(100);
        setStatus("ready");
      }
    }, DISMISS_SNOOZE_MS);
  }, []);

  return { status, update, progress, restartAndInstall, dismiss };
}
