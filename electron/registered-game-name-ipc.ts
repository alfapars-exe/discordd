import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { validateGameDisplayName } from "./registered-games";
/** Same main-window trust boundary as all local registry mutations. */
export function registerGameNameIPC(ipc: Pick<IpcMain, "handle">, trusted: (event: IpcMainInvokeEvent) => void,
  registry: { setDisplayName: (id: string, name: string) => Promise<boolean> }) {
  ipc.handle("set-registered-game-name", (event, id: unknown, name: unknown) => {
    trusted(event);
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError("Invalid registered game id.");
    return registry.setDisplayName(id, validateGameDisplayName(name));
  });
}
