import type { IpcMain } from "electron";

type AppCommands = {
  getVersion: () => string;
  relaunch: () => void;
  quit: () => void;
  writeClipboard: (text: string) => void;
  assertString: (value: unknown, name: string, max: number) => asserts value is string;
};

export function registerAppCommandIPC(ipc: Pick<IpcMain, "handle">, operations: AppCommands): void {
  const assertString: AppCommands["assertString"] = operations.assertString;
  ipc.handle("get-version", () => operations.getVersion());
  ipc.handle("relaunch", () => { operations.relaunch(); operations.quit(); });
  ipc.handle("write-clipboard", (_event, text: unknown) => {
    assertString(text, "clipboard text", 10 * 1024 * 1024);
    operations.writeClipboard(text);
  });
}
