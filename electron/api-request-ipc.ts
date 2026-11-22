import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { ApiRequestBinding, createApiRequestCancellation } from "./api-request-cancellation";

/** Private cancellation channels; arbitrary IPC and fetch are never exposed. */
export function registerApiRequestIPC(ipc: Pick<IpcMain, "handle" | "removeHandler">, operations: {
  trusted: (event: IpcMainInvokeEvent) => void;
  requests: ReturnType<typeof createApiRequestCancellation>;
}) {
  const tracked = new Map<WebContents, () => void>();
  const track = (contents: WebContents) => {
    if (tracked.has(contents)) return;
    const retire = () => operations.requests.retire(contents);
    const navigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) retire();
    };
    const detach = () => {
      contents.removeListener("destroyed", destroyed);
      contents.removeListener("render-process-gone", retire);
      contents.removeListener("did-start-navigation", navigating);
      tracked.delete(contents);
    };
    const destroyed = () => { retire(); detach(); };
    contents.on("destroyed", destroyed);
    contents.on("render-process-gone", retire);
    contents.on("did-start-navigation", navigating);
    tracked.set(contents, detach);
  };
  ipc.handle("reserve-api-request", (event, binding: ApiRequestBinding) => {
    operations.trusted(event);
    const id = operations.requests.reserve({ sender: event.sender, frame: event.senderFrame! }, binding);
    track(event.sender);
    return id;
  });
  ipc.handle("cancel-api-request", (event, id: unknown) => {
    operations.trusted(event);
    return operations.requests.cancel({ sender: event.sender, frame: event.senderFrame! }, id);
  });
  return () => {
    ipc.removeHandler("reserve-api-request"); ipc.removeHandler("cancel-api-request");
    operations.requests.dispose();
    for (const detach of [...tracked.values()]) detach();
  };
}
