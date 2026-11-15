/** Electron update subscriptions and snooze timer ownership. No-op on the web. */
import { useReducer, useEffect, useCallback } from "react";
import { isElectron } from "../utils/constants";
import { initialUpdateCheckerState, updateCheckerState, type UpdateInfo } from "../utils/updateCheckerState";
import { ownSubscriptions } from "../utils/ownSubscriptions";

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
    return ownSubscriptions([
      () => api.onUpdateAvailable(info => dispatch({ type: "available", version: info.version })),
      () => api.onUpdateProgress(info => dispatch({ type: "progress", percent: info.percent })),
      () => api.onUpdateDownloaded(info => dispatch({ type: "downloaded", version: info?.version ?? "" })),
      () => api.onUpdateError(message => {
        console.warn("[updater] Update check failed:", message);
        dispatch({ type: "error" });
      }),
    ]);
  }, []);

  const token = state.snoozeToken;
  useEffect(() => {
    if (token === null) return;
    const timer = setTimeout(() => dispatch({ type: "resume", token }), DISMISS_SNOOZE_MS);
    return () => clearTimeout(timer);
  }, [token]);

  const restartAndInstall = useCallback(() => {
    if (!isElectron()) return;
    void window.electronAPI!.installUpdate().catch(() => {
      console.warn("[updater] Install request failed");
    });
  }, []);
  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);
  return { status: state.status, update: state.update, progress: state.progress, restartAndInstall, dismiss };
}
