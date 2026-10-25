import type { IpcMain, IpcMainInvokeEvent } from "electron";
export function registerOverlayGameNoticeClearIPC(ipc: Pick<IpcMain, "handle">, assertMain: (event: IpcMainInvokeEvent) => void, clear: () => void): void {
  ipc.handle("clear-overlay-game-notices", (event, ...args: unknown[]) => {
    assertMain(event);
    if (args.length !== 0) throw new TypeError("notice clear accepts no payload");
    clear();
  });
}
