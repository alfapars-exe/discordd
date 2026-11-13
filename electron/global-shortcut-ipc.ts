import type { IpcMain, IpcMainInvokeEvent } from "electron";

type ShortcutOperations = Pick<typeof import("./push-to-talk"), "registerPTT" | "unregisterPTT" | "registerMuteHotkey" | "unregisterMuteHotkey"> & {
  trusted: (event: IpcMainInvokeEvent) => void;
  assertString: (value: unknown, name: string, max: number) => asserts value is string;
};

export function registerGlobalShortcutIPC(ipc: Pick<IpcMain, "handle">, operations: ShortcutOperations): void {
  const assertString: ShortcutOperations["assertString"] = operations.assertString;
  ipc.handle("register-ptt-shortcut", (event, keyCode: unknown) => {
    operations.trusted(event);
    assertString(keyCode, "PTT keyCode", 64);
    return operations.registerPTT(keyCode);
  });
  ipc.handle("unregister-ptt-shortcut", event => { operations.trusted(event); operations.unregisterPTT(); });
  ipc.handle("register-mute-hotkey-shortcut", (event, keyCode: unknown) => {
    operations.trusted(event);
    assertString(keyCode, "mute hotkey keyCode", 64);
    return operations.registerMuteHotkey(keyCode);
  });
  ipc.handle("unregister-mute-hotkey-shortcut", event => { operations.trusted(event); operations.unregisterMuteHotkey(); });
}
