import type { IpcMain } from "electron";

type UpdaterOperations = {
  wasPrelaunchChecked: () => boolean;
  checkForUpdates: () => Promise<{ updateInfo: unknown } | null | undefined>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => void;
};

export function registerUpdaterIPC(ipc: Pick<IpcMain, "handle">, operations: UpdaterOperations): void {
  ipc.handle("was-update-checked", () => operations.wasPrelaunchChecked());
  ipc.handle("check-update", async () => {
    try {
      const result = await operations.checkForUpdates();
      return result?.updateInfo ?? null;
    } catch {
      return null;
    }
  });
  ipc.handle("download-update", async () => {
    try {
      await operations.downloadUpdate();
      return true;
    } catch {
      return false;
    }
  });
  ipc.handle("install-update", () => operations.quitAndInstall(true, true));
}
