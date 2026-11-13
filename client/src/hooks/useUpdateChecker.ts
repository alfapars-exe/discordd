/** Electron update subscriptions and snooze timer ownership. No-op on the web. */
import { useReducer, useEffect, useCallback } from "react";
import { isElectron } from "../utils/constants";
import { initialUpdateCheckerState, updateCheckerState, type UpdateInfo } from "../utils/updateCheckerState";

const DISMISS_SNOOZE_MS = 30 * 60 * 1000;
type UpdateChecker = {
  status: "idle" | "downloading" | "ready";
  update: UpdateInfo | null;
  progress: number;
  restartAndInstall: () => void;
  dismiss: () => void;
};

export function useUpdateChecker(): UpdateChecker {
  const [state, dispatch] = useReducer(updateCheckerState, initialUpdateCheckerState);
  useEffect(() => {
    if (!isElectron()) return;
    const api = window.electronAPI!;
    const stopAvailable = api.onUpdateAvailable(info => dispatch({ type: "available", version: info.version }));
    const stopProgress = api.onUpdateProgress(info => dispatch({ type: "progress", percent: info.percent }));
    const stopDownloaded = api.onUpdateDownloaded(info => dispatch({ type: "downloaded", version: info?.version ?? "" }));
    const stopError = api.onUpdateError(message => {
      console.warn("[updater] Update check failed:", message);
      dispatch({ type: "error" });
    });
    return () => {
      stopAvailable?.(); stopProgress?.(); stopDownloaded?.(); stopError?.();
    };
  }, []);

  const token = state.snoozeToken;
  useEffect(() => {
    if (token === null) return;
    const timer = setTimeout(() => dispatch({ type: "resume", token }), DISMISS_SNOOZE_MS);
    return () => clearTimeout(timer);
  }, [token]);

  const restartAndInstall = useCallback(() => {
    if (isElectron()) void window.electronAPI!.installUpdate();
  }, []);
  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);
  return { status: state.status, update: state.update, progress: state.progress, restartAndInstall, dismiss };
}