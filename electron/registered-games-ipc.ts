import type { IpcMain, IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue } from "electron";
import { registerGameNameIPC } from "./registered-game-name-ipc";

type Registry = Pick<ReturnType<typeof import("./registered-games").createRegisteredGamesService>,
  "snapshot" | "getActivity" | "setBackgroundDetectionEnabled" | "addExecutable" | "remove" | "setDisplayName" | "setJoinAdapter" | "setShareAllowed" | "setOverlayAllowed">;
type RegistryOperations = {
  trusted: (event: IpcMainInvokeEvent) => void;
  assertString: (value: unknown, name: string, max: number) => asserts value is string;
  registeredGames: Registry;
  platform: NodeJS.Platform;
  overlaySupported: boolean;
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
  removeLayout: (key: `game:${string}`) => unknown;
};

/** Local registry commands; detection/tracker startup and shutdown remain with their owner. */
export function registerRegisteredGamesIPC(ipc: Pick<IpcMain, "handle">, operations: RegistryOperations): void {
  const { trusted, registeredGames, platform, overlaySupported } = operations;
  const assertString: RegistryOperations["assertString"] = operations.assertString;
  ipc.handle("get-registered-games", (event) => {
    trusted(event);
    return registeredGames.snapshot().then((snapshot) => ({ ...snapshot, overlaySupport: platform !== "win32" ? "unsupported" : overlaySupported ? "available" : "unavailable" }));
  });
  ipc.handle("get-registered-game-activity", (event) => {
    trusted(event);
    return registeredGames.getActivity();
  });
  ipc.handle("set-registered-games-background-detection", async (event, enabled: unknown) => {
    trusted(event);
    if (typeof enabled !== "boolean") throw new TypeError("background detection setting must be boolean");
    return registeredGames.setBackgroundDetectionEnabled(enabled);
  });
  ipc.handle("add-registered-game", async (event) => {
    trusted(event);
    if (platform !== "win32") return null;
    const result = await operations.showOpenDialog({
      title: "Select a game executable",
      properties: ["openFile"],
      filters: [{ name: "Windows applications", extensions: ["exe"] }],
    });
    const selected = result.canceled ? undefined : result.filePaths[0];
    return selected ? registeredGames.addExecutable(selected) : null;
  });
  ipc.handle("remove-registered-game", async (event, id: unknown) => {
    trusted(event);
    assertString(id, "game id", 64);
    const removed = await registeredGames.remove(id);
    if (removed) operations.removeLayout(`game:${id}`);
    return removed;
  });
  registerGameNameIPC(ipc, trusted, registeredGames);
  ipc.handle("set-registered-game-join-adapter", (event, id: unknown, adapter: unknown) => {
    trusted(event);
    assertString(id, "registered game id", 64);
    return registeredGames.setJoinAdapter(id, adapter);
  });

  ipc.handle("set-registered-game-sharing", async (event, id: unknown, allowed: unknown) => {
    trusted(event);
    assertString(id, "game id", 64);
    if (typeof allowed !== "boolean") throw new TypeError("sharing permission must be boolean");
    return registeredGames.setShareAllowed(id, allowed);
  });

  ipc.handle("set-registered-game-overlay", async (event, id: unknown, allowed: unknown) => {
    trusted(event);
    assertString(id, "game id", 64);
    if (typeof allowed !== "boolean") throw new TypeError("overlay permission must be boolean");
    return registeredGames.setOverlayAllowed(id, allowed);
  });
}
