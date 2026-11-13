import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent, NativeImage } from "electron";
import { isTrustedVoiceOverlaySender } from "./voice-overlay-contract";
import { registerWindowControlIPC } from "./window-control-ipc";

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const calls: unknown[][] = [];
  const state = { present: true, focused: false, maximized: false, rejectValidation: false, destroyed: false, retireAfterAuthorization: false };
  const image = {} as NativeImage;
  const contents = { mainFrame: {} };
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  const window = {
    webContents: contents,
    isDestroyed: () => state.destroyed,
    setOverlayIcon: (...args: unknown[]) => { calls.push(["badge", ...args]); },
    isFocused: () => state.focused,
    flashFrame: (value: boolean) => { calls.push(["flash", value]); },
    minimize: () => { calls.push(["minimize"]); },
    isMaximized: () => state.maximized,
    unmaximize: () => { calls.push(["unmaximize"]); },
    maximize: () => { calls.push(["maximize"]); },
    close: () => { calls.push(["close"]); },
  };
  registerWindowControlIPC({ handle: (name, callback) => handlers.set(name, callback) } satisfies Pick<IpcMain, "handle">, {
    trusted: received => { if (!isTrustedVoiceOverlaySender(received, state.present ? window : null)) throw new Error("Untrusted IPC sender."); if (state.retireAfterAuthorization) state.present = false; },
    getMainWindow: () => state.present ? window : null,
    createBadgeImage: url => { calls.push(["image", url]); return image; },
    setTrayTooltip: text => { calls.push(["tooltip", text]); },
    assertString: (value, name, max): asserts value is string => { calls.push(["string", value, name, max]); if (state.rejectValidation) throw new TypeError("rejected"); },
    assertFiniteNumber: (value, name, min, max): asserts value is number => { calls.push(["number", value, name, min, max]); if (state.rejectValidation) throw new TypeError("rejected"); },
  });
  return { calls, state, image, contents, event, invokeFrom: (received: IpcMainInvokeEvent, name: string, ...args: unknown[]) => handlers.get(name)!(received, ...args), invoke: (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args) };
}

test("badge delegates bounded validation before creating an image and updating native state", () => {
  const h = harness(); h.invoke("set-badge-count", 12, "data:image/png;base64,fixture");
  assert.deepEqual(h.calls, [["number", 12, "badge count", 0, 99999], ["string", "data:image/png;base64,fixture", "iconDataURL", 262144], ["image", "data:image/png;base64,fixture"], ["badge", h.image, "12 unread"], ["tooltip", "HiChat! (12)"]]);
});

test("badge clear and absent-icon paths never create an image", () => {
  const h = harness(); h.invoke("set-badge-count", 0, null);
  assert.deepEqual(h.calls, [["number", 0, "badge count", 0, 99999], ["badge", null, ""], ["tooltip", "HiChat!"]]);
  h.calls.length = 0; h.invoke("set-badge-count", 3, null);
  assert.deepEqual(h.calls, [["number", 3, "badge count", 0, 99999], ["badge", null, ""], ["tooltip", "HiChat! (3)"]]);
});

test("validation rejection and non-image URLs cannot mutate badge or tray state", () => {
  const h = harness(); h.state.rejectValidation = true;
  assert.throws(() => h.invoke("set-badge-count", NaN, null), /rejected/);
  h.state.rejectValidation = false;
  for (const url of ["https://fixture/icon.png", "javascript:fixture", "file:///fixture"]) assert.throws(() => h.invoke("set-badge-count", 1, url), /data:image/);
  assert.equal(h.calls.some(call => ["image", "badge", "tooltip"].includes(String(call[0]))), false);
});

test("window controls resolve current state and tolerate an owner disappearing after authorization", () => {
  const h = harness();
  h.invoke("flash-frame"); h.state.focused = true; h.invoke("flash-frame");
  h.invoke("minimize-window"); h.invoke("maximize-window"); h.state.maximized = true; h.invoke("maximize-window"); h.invoke("close-window");
  assert.deepEqual(h.calls, [["flash", true], ["minimize"], ["maximize"], ["unmaximize"], ["close"]]);
  h.calls.length = 0; h.state.retireAfterAuthorization = true;
  for (const channel of ["flash-frame", "minimize-window", "maximize-window", "close-window"]) { h.state.present = true; h.invoke(channel); }
  h.state.present = true; h.invoke("set-badge-count", 2, null);
  assert.deepEqual(h.calls, [["number", 2, "badge count", 0, 99999]]);
});

function expectWindowDenied(h: ReturnType<typeof harness>, event: IpcMainInvokeEvent) {
  for (const channel of ["set-badge-count", "flash-frame", "minimize-window", "maximize-window", "close-window"]) {
    assert.throws(() => h.invokeFrom(event, channel, NaN, null), /Untrusted IPC sender/);
  }
}

test("window commands reject foreign senders before badge validation or native effects", () => {
  const h = harness();
  for (const event of [
    { sender: {}, senderFrame: {} },
    { sender: h.contents, senderFrame: {} },
    { sender: h.contents, senderFrame: null },
  ]) expectWindowDenied(h, event as unknown as IpcMainInvokeEvent);
  assert.deepEqual(h.calls, []);
});

test("retired window frames cannot mutate the replacement main window", () => {
  const h = harness();
  h.state.present = false; expectWindowDenied(h, h.event);
  h.state.present = true; h.state.destroyed = true; expectWindowDenied(h, h.event);
  h.state.destroyed = false; h.contents.mainFrame = {}; expectWindowDenied(h, h.event);
  assert.deepEqual(h.calls, []);
  h.invokeFrom({ sender: h.contents, senderFrame: h.contents.mainFrame } as unknown as IpcMainInvokeEvent, "close-window");
  assert.deepEqual(h.calls, [["close"]]);
});
