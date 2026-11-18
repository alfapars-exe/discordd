import type { IpcMain, IpcMainInvokeEvent } from "electron";

type AppCommands = {
  trusted: (event: IpcMainInvokeEvent) => void;
  getVersion: () => string;
  relaunch: () => void;
  quit: () => void;
  writeClipboard: (text: string) => void;
  assertString: (value: unknown, name: string, max: number) => asserts value is string;
};

export function registerAppCommandIPC(ipc: Pick<IpcMain, "handle">, operations: AppCommands): void {
  const assertString: AppCommands["assertString"] = operations.assertString;
  ipc.handle("get-version", () => operations.getVersion());
  ipc.handle("relaunch", event => { operations.trusted(event); operations.relaunch(); operations.quit(); });
  ipc.handle("write-clipboard", (event, text: unknown) => {
    operations.trusted(event);
    assertString(text, "clipboard text", 10 * 1024 * 1024);
    operations.writeClipboard(text);
  });
}
