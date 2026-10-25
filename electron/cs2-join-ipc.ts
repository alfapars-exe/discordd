import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createCS2JoinController } from "./cs2-join-controller";

/** Only the current MAIN document may project auth context or dispatch a ticket. */
export function registerCS2JoinIPC(ipc: Pick<IpcMain, "handle">, trusted: (event: IpcMainInvokeEvent) => void,
  options: Omit<Parameters<typeof createCS2JoinController>[0], "isCurrent"> & { supported: boolean }) {
  const endpoints = new WeakMap<object, { event: IpcMainInvokeEvent }>();
  const watched = new WeakMap<object, { owned: Set<{ event: IpcMainInvokeEvent }>; ready: boolean }>();
  const controller = createCS2JoinController({ ...options, isCurrent: endpoint => {
    const value = endpoint as { event: IpcMainInvokeEvent };
    try { trusted(value.event); return watched.get(value.event.sender)?.ready === true; } catch { return false; }
  } });
  function endpoint(event: IpcMainInvokeEvent) {
    trusted(event);
    if (!event.senderFrame) throw new Error("Missing main frame.");
    let value = endpoints.get(event.senderFrame);
    if (!value) { value = { event }; endpoints.set(event.senderFrame, value); }
    let document = watched.get(event.sender);
    if (!document) {
      document = { owned: new Set(), ready: true }; watched.set(event.sender, document);
      const retire = () => { document!.ready = false; for (const item of document!.owned) controller.retire(item); document!.owned.clear(); };
      event.sender.on("did-start-navigation", (_event, _url, inPlace, main) => { if (main && !inPlace) retire(); });
      event.sender.on("render-process-gone", retire);
      event.sender.on("destroyed", retire);
      event.sender.on("did-finish-load", () => { document!.ready = true; });
    }
    document.owned.add(value);
    return value;
  }
  ipc.handle("sync-game-join-context", (event, raw: unknown) => {
    const sender = endpoint(event);
    if (!options.supported) return { accepted: false, scopeNonce: null };
    return controller.sync(sender, raw);
  });
  ipc.handle("launch-cs2-game-join", (event, raw: unknown) => {
    const sender = endpoint(event);
    return options.supported ? controller.launch(sender, raw) : "unavailable";
  });
  return { dispose: () => controller.retire() };
}
