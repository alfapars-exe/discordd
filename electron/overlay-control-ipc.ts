import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { createOverlayMediaBroker } from "./overlay-media-broker";
import type { createOverlayShortcutController, OverlayShortcutBinding } from "./overlay-shortcut";

type Operations = {
  trusted(event: IpcMainInvokeEvent): void;
  resetLayout(): boolean;
  lock(): void;
  shortcut: Pick<ReturnType<typeof createOverlayShortcutController>, "setBinding">;
  media: Pick<ReturnType<typeof createOverlayMediaBroker>, "open" | "send" | "viewport" | "setReady" | "getAvailability">;
};

// The broker owns media sender/session validation. Layout and shortcut commands
// retain the main-window predicate; neither path bypasses its domain owner.
export function registerOverlayControlIPC(ipc: Pick<IpcMain, "handle">, operations: Operations): void {
  ipc.handle("reset-overlay-layout", event => {
    operations.trusted(event);
    return operations.resetLayout();
  });
  ipc.handle("set-overlay-shortcut", (event, binding: unknown) => {
    operations.trusted(event);
    const accepted = operations.shortcut.setBinding(binding as OverlayShortcutBinding | null);
    if (binding === null) operations.lock();
    return accepted;
  });
  ipc.handle("open-overlay-media-lease", (event, raw: unknown) => operations.media.open(event, raw));
  ipc.handle("send-overlay-media", (event, raw: unknown) => operations.media.send(event, raw));
  ipc.handle("send-overlay-media-viewport", (event, raw: unknown) => operations.media.viewport(event, raw));
  ipc.handle("set-overlay-media-receiver-ready", (event, ready: unknown) => operations.media.setReady(event, ready));
  ipc.handle("get-overlay-media-availability", event => operations.media.getAvailability(event));
}
