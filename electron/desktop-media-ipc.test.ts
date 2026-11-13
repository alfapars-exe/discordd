import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { isTrustedVoiceOverlaySender } from "./voice-overlay-contract";
import { registerDesktopMediaIPC } from "./desktop-media-ipc";

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();
  const calls: unknown[][] = [];
  const state = { bounds: { x: -1920, y: 0, width: 800, height: 600 }, windowPresent: true, destroyed: false,
    display: { size: { width: 1537, height: 865 }, scaleFactor: 1.25, displayFrequency: 144 },
    sources: [{ id: "window:fixture", name: "Fixture", thumbnail: "data:image/png;base64,fixture" }] };
  const contents = { mainFrame: {} };
  const main = { isDestroyed: () => state.destroyed, webContents: contents };
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  registerDesktopMediaIPC({ handle: (channel, callback) => handlers.set(channel, callback) } satisfies Pick<IpcMain, "handle">, {
    trusted: received => { if (!isTrustedVoiceOverlaySender(received, state.windowPresent ? main : null)) throw new Error("Untrusted IPC sender."); },
    getSerializedSources: async () => { calls.push(["sources"]); return state.sources; },
    getMainWindow: () => state.windowPresent ? { getBounds: () => state.bounds } : null,
    screen: {
      getDisplayMatching: bounds => { calls.push(["matching", bounds]); return state.display; },
      getPrimaryDisplay: () => { calls.push(["primary"]); return state.display; },
      getAllDisplays: () => [state.display, state.display],
    },
  });
  return { state, calls, handlers, contents, event, invokeFrom: (received: IpcMainInvokeEvent, channel: string) => handlers.get(channel)!(received), invoke: (channel: string) => handlers.get(channel)!(event) };
}

test("display metrics follow the current window monitor and round physical pixels", () => {
  const h = harness();
  assert.deepEqual(h.invoke("get-display-info"), { width: 1921, height: 1081, refreshRate: 144, scaleFactor: 1.25, monitorCount: 2 });
  assert.deepEqual(h.calls, [["matching", h.state.bounds]]);
  h.state.bounds = { x: 0, y: 0, width: 1000, height: 700 };
  h.state.display = { size: { width: 1920, height: 1080 }, scaleFactor: 2, displayFrequency: 60 };
  assert.deepEqual(h.invoke("get-display-info"), { width: 3840, height: 2160, refreshRate: 60, scaleFactor: 2, monitorCount: 2 });
  assert.deepEqual(h.calls[1], ["matching", h.state.bounds]);
});

test("without a main window metrics use primary display and retain an unknown refresh rate", () => {
  const h = harness(); h.state.windowPresent = false; h.state.display.displayFrequency = 0;
  const result = h.invoke("get-display-info") as { refreshRate: number };
  assert.equal(result.refreshRate, 0);
  assert.deepEqual(h.calls, [["primary"]]);
});

test("legacy enumeration returns provider sources without caching or changing their shape", async () => {
  const h = harness();
  assert.equal(await h.invoke("get-desktop-sources"), h.state.sources);
  h.state.sources = [];
  assert.deepEqual(await h.invoke("get-desktop-sources"), []);
  assert.deepEqual(h.calls, [["sources"], ["sources"]]);
  assert.equal(h.handlers.size, 2);
});

test("desktop source enumeration rejects foreign contents and frames before provider access", async () => {
  const h = harness();
  for (const event of [
    { sender: {}, senderFrame: {} },
    { sender: h.contents, senderFrame: {} },
    { sender: h.contents, senderFrame: null },
  ]) await assert.rejects(async () => h.invokeFrom(event as unknown as IpcMainInvokeEvent, "get-desktop-sources"), /Untrusted IPC sender/);
  assert.deepEqual(h.calls, []);
});

test("retired desktop source callers cannot enumerate but a current main frame can", async () => {
  const h = harness();
  h.state.windowPresent = false;
  await assert.rejects(async () => h.invoke("get-desktop-sources"), /Untrusted IPC sender/);
  h.state.windowPresent = true; h.state.destroyed = true;
  await assert.rejects(async () => h.invoke("get-desktop-sources"), /Untrusted IPC sender/);
  h.state.destroyed = false; h.contents.mainFrame = {};
  await assert.rejects(async () => h.invoke("get-desktop-sources"), /Untrusted IPC sender/);
  assert.deepEqual(h.calls, []);
  assert.equal(await h.invokeFrom({ sender: h.contents, senderFrame: h.contents.mainFrame } as unknown as IpcMainInvokeEvent, "get-desktop-sources"), h.state.sources);
  assert.deepEqual(h.calls, [["sources"]]);
});
