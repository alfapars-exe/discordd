import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent, NativeImage } from "electron";
import { registerWindowControlIPC } from "./window-control-ipc";

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const calls: unknown[][] = [];
  const state = { present: true, focused: false, maximized: false, rejectValidation: false };
  const image = {} as NativeImage;
  const window = {
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
    getMainWindow: () => state.present ? window : null,
    createBadgeImage: url => { calls.push(["image", url]); return image; },
    setTrayTooltip: text => { calls.push(["tooltip", text]); },
    assertString: (value, name, max): asserts value is string => { calls.push(["string", value, name, max]); if (state.rejectValidation) throw new TypeError("rejected"); },
    assertFiniteNumber: (value, name, min, max): asserts value is number => { calls.push(["number", value, name, min, max]); if (state.rejectValidation) throw new TypeError("rejected"); },
  });
  return { calls, state, image, invoke: (name: string, ...args: unknown[]) => handlers.get(name)!({} as IpcMainInvokeEvent, ...args) };
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

test("window controls resolve current state and do nothing when the main window is absent", () => {
  const h = harness();
  h.invoke("flash-frame"); h.state.focused = true; h.invoke("flash-frame");
  h.invoke("minimize-window"); h.invoke("maximize-window"); h.state.maximized = true; h.invoke("maximize-window"); h.invoke("close-window");
  assert.deepEqual(h.calls, [["flash", true], ["minimize"], ["maximize"], ["unmaximize"], ["close"]]);
  h.calls.length = 0; h.state.present = false;
  for (const channel of ["flash-frame", "minimize-window", "maximize-window", "close-window"]) h.invoke(channel);
  h.invoke("set-badge-count", 2, null);
  assert.deepEqual(h.calls, [["number", 2, "badge count", 0, 99999]]);
});
