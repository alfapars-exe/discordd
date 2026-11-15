import type { AppUpdater, UpdateDownloadedEvent } from "electron-updater";
import type { ProgressInfo, UpdateInfo } from "builder-util-runtime";

type RuntimeUpdaterOperations = {
  updater: Pick<AppUpdater, "on" | "removeListener" | "checkForUpdates">;
  available: (info: UpdateInfo) => void;
  progress: (info: ProgressInfo) => void;
  downloaded: (info: UpdateDownloadedEvent) => void;
  failed: (error: Error) => void;
  startPolling: (check: () => void) => () => void;
};

/** Own exactly these subscriptions and this poller, preserving other owners. */
export function startRuntimeUpdater(operations: RuntimeUpdaterOperations): () => void {
  let disposed = false;
  const available = (info: UpdateInfo) => { if (!disposed) operations.available(info); };
  const progress = (info: ProgressInfo) => { if (!disposed) operations.progress(info); };
  const downloaded = (info: UpdateDownloadedEvent) => { if (!disposed) operations.downloaded(info); };
  const failed = (error: Error) => { if (!disposed) operations.failed(error); };
  const { updater } = operations;
  const check = () => {
    if (disposed) return;
    try {
      // The SDK reports rejected checks through its error event. A synchronous
      // failure has no rejected promise to observe and must not escape a timer.
      void updater.checkForUpdates().catch(() => undefined);
    } catch (error) {
      failed(error instanceof Error ? error : new Error("Update check failed"));
    }
  };
  let stopPolling: (() => void) | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { stopPolling?.(); }
    finally {
      updater.removeListener("update-available", available);
      updater.removeListener("download-progress", progress);
      updater.removeListener("update-downloaded", downloaded);
      updater.removeListener("error", failed);
    }
  };
  try {
    updater.on("update-available", available);
    updater.on("download-progress", progress);
    updater.on("update-downloaded", downloaded);
    updater.on("error", failed);
    check();
    stopPolling = operations.startPolling(check);
    return dispose;
  } catch (error) {
    try { dispose(); } catch { /* Preserve the acquisition failure. */ }
    throw error;
  }
}
