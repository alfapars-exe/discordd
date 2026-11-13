import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle } from "electron";
import { createOverlayActionWindow } from "./overlay-action-window";

function harness() {
  const calls: unknown[][] = [];
  const state = { shapeFails: false, load: Promise.resolve() };
  let options: BrowserWindowConstructorOptions | undefined;
  const window = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { isLoading: (): boolean => false }),
    setShape: (regions: Rectangle[]) => { calls.push(["shape", regions]); if (state.shapeFails) throw new Error("shape unavailable"); },
    setAlwaysOnTop: (...args: unknown[]) => { calls.push(["top", ...args]); },
    loadURL: (url: string) => { calls.push(["load", url]); return state.load; },
  });
  const nativeWindow = window as unknown as BrowserWindow;
  const parent = {} as BrowserWindow;
  const regions = [{ x: 0, y: 0, width: 40, height: 40 }];
  return {
    calls, state, window, nativeWindow, parent, regions, options: () => options,
    create: (surface: "actions" | "notification-actions" | "chat-actions" = "actions", development = false) => createOverlayActionWindow({
      surface, width: 88, height: 40, parent, preload: "/fixture/preload.js", development, regions,
    }, {
      createWindow: value => { options = value; return nativeWindow; },
      created: value => { calls.push(["created", value]); },
      closed: value => { calls.push(["closed", value]); },
      failed: (value, reason) => { calls.push(["failed", value, reason]); },
    }),
  };
}

test("all action surfaces retain sandboxed non-focusable child policy and exact development/production URLs", () => {
  for (const surface of ["actions", "notification-actions", "chat-actions"] as const) {
    for (const development of [false, true]) {
      const h = harness(); assert.equal(h.create(surface, development), h.nativeWindow);
      assert.deepEqual(h.options(), {
        width: 88, height: 40, frame: false, transparent: true, resizable: false,
        alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false,
        show: false, parent: h.parent,
        webPreferences: { preload: "/fixture/preload.js", contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      assert.deepEqual(h.calls, [["created", h.nativeWindow], ["shape", h.regions], ["top", true, "floating"], ["load", `${development ? "http://localhost:3030" : "app://hichat"}/overlay.html?surface=${surface}`]]);
    }
  }
});

test("shape failure reports its owned window before any URL is loaded", () => {
  const h = harness(); h.state.shapeFails = true;
  assert.equal(h.create(), null);
  assert.deepEqual(h.calls, [["created", h.nativeWindow], ["shape", h.regions], ["failed", h.nativeWindow, "shape"]]);
});

test("asynchronous load rejection is consumed and reports the exact failed child", async () => {
  const h = harness(); let reject!: (error: Error) => void;
  h.state.load = new Promise<void>((_resolve, fail) => { reject = fail; });
  assert.equal(h.create(), h.nativeWindow);
  reject(new Error("fixture load failed"));
  await Promise.resolve();
  assert.deepEqual(h.calls[h.calls.length - 1], ["failed", h.nativeWindow, "load"]);
});

test("close callbacks carry their original child identity for owner revalidation", () => {
  const first = harness(), second = harness(); first.create(); second.create();
  first.window.emit("closed");
  assert.deepEqual(first.calls[first.calls.length - 1], ["closed", first.nativeWindow]);
  assert.equal(second.calls.some(call => call[0] === "closed"), false);
});

test("renderer crash reports its owned child and close removes only owned listeners", async () => {
  const h = harness(); let reject!: (error: Error) => void;
  h.state.load = new Promise<void>((_resolve, fail) => { reject = fail; });
  const sibling = () => {};
  h.window.webContents.on("render-process-gone", sibling);
  h.create();
  const queued = h.window.webContents.listeners("render-process-gone")[1];
  h.window.webContents.emit("render-process-gone");
  assert.deepEqual(h.calls[h.calls.length - 1], ["failed", h.nativeWindow, "crash"]);
  h.window.emit("closed");
  const count = h.calls.length;
  queued();
  reject(new Error("late load"));
  await Promise.resolve();
  assert.equal(h.calls.length, count, "retired callbacks cannot affect a replacement owner");
  assert.deepEqual(h.window.webContents.listeners("render-process-gone"), [sibling]);
  assert.equal(h.window.listenerCount("closed"), 0);
});

test("only a loaded main document navigation retires an action owner", () => {
  const h = harness();
  h.window.webContents.isLoading = () => true;
  h.create();
  const navigate = (inPlace: boolean, mainFrame: boolean) => h.window.webContents.emit("did-start-navigation", {}, "app://hichat/overlay.html", inPlace, mainFrame);
  navigate(false, true);
  assert.equal(h.calls.some(call => call[0] === "failed"), false, "initial navigation is permitted");
  h.window.webContents.emit("did-finish-load");
  navigate(true, true); navigate(false, false);
  assert.equal(h.calls.some(call => call[0] === "failed"), false);
  const queued = h.window.webContents.listeners("did-start-navigation")[0];
  navigate(false, true);
  assert.deepEqual(h.calls[h.calls.length - 1], ["failed", h.nativeWindow, "navigation"]);
  h.window.emit("closed");
  const count = h.calls.length;
  queued({}, "app://hichat/overlay.html", false, true);
  assert.equal(h.calls.length, count);
  assert.equal(h.window.webContents.listenerCount("did-start-navigation"), 0);
  assert.equal(h.window.webContents.listenerCount("did-finish-load"), 0);
});
