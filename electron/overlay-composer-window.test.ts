import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { createOverlayComposerWindow } from "./overlay-composer-window";

function harness() {
  const calls: unknown[][] = [], contents = new EventEmitter();
  const state = { loading: true, load: Promise.resolve() };
  let options: BrowserWindowConstructorOptions | undefined;
  const window = Object.assign(new EventEmitter(), {
    webContents: Object.assign(contents, { isLoading: () => state.loading }),
    setAlwaysOnTop: (...args: unknown[]) => { calls.push(["top", ...args]); },
    loadURL: (url: string) => { calls.push(["load", url]); return state.load; },
  });
  const nativeWindow = window as unknown as BrowserWindow, parent = {} as BrowserWindow;
  const bounds = { x: -500, y: 20, width: 360, height: 280 };
  return { calls, contents, state, window, nativeWindow, parent, bounds, options: () => options,
    create: (development = false) => createOverlayComposerWindow({ bounds, parent, preload: "/fixture/preload.js", development }, {
      createWindow: value => { options = value; return nativeWindow; },
      created: value => { calls.push(["created", value]); },
      ready: value => { calls.push(["ready", value]); },
      closed: value => { calls.push(["closed", value]); },
      retire: (value, reason) => { calls.push(["retire", value, reason]); window.emit("closed"); },
    }),
  };
}

test("composer creation preserves its focused sandboxed child policy and fixed surface URL", () => {
  for (const development of [false, true]) {
    const h = harness(); h.state.loading = false;
    assert.equal(h.create(development), h.nativeWindow);
    assert.deepEqual(h.options(), {
      ...h.bounds, frame: false, transparent: true, resizable: false, alwaysOnTop: true,
      focusable: true, skipTaskbar: true, hasShadow: true, show: false, parent: h.parent,
      webPreferences: { preload: "/fixture/preload.js", contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    assert.deepEqual(h.calls, [["created", h.nativeWindow], ["top", true, "floating"], ["load", `${development ? "http://localhost:3030" : "app://hichat"}/overlay.html?surface=chat-composer`], ["ready", h.nativeWindow]]);
  }
});

test("only a main document navigation after initial load retires the composer", () => {
  const h = harness(); h.create();
  h.contents.emit("did-start-navigation", {}, "initial", false, true);
  assert.equal(h.calls.some(call => call[0] === "retire"), false);
  h.contents.emit("did-finish-load"); h.contents.emit("did-finish-load");
  assert.equal(h.calls.filter(call => call[0] === "ready").length, 1);
  h.contents.emit("did-start-navigation", {}, "subframe", false, false);
  h.contents.emit("did-start-navigation", {}, "in-place", true, true);
  assert.equal(h.calls.some(call => call[0] === "retire"), false);
  h.contents.emit("did-start-navigation", {}, "reload", false, true);
  assert.deepEqual(h.calls[h.calls.length - 2], ["retire", h.nativeWindow, "navigation"]);
});

test("close removes only owned listeners and ignores already queued callbacks", () => {
  const h = harness(); let sibling = 0;
  h.contents.on("did-start-navigation", () => { sibling++; }); h.create();
  const ready = h.contents.listeners("did-finish-load")[0], crashed = h.contents.listeners("render-process-gone")[0];
  h.window.emit("closed"); h.window.emit("closed");
  assert.equal(h.contents.listenerCount("did-start-navigation"), 1);
  assert.equal(h.contents.listenerCount("did-finish-load"), 0);
  assert.equal(h.contents.listenerCount("render-process-gone"), 0);
  ready(); crashed();
  h.contents.emit("did-start-navigation", {}, "sibling", false, true);
  assert.equal(sibling, 1);
  assert.equal(h.calls.filter(call => call[0] === "closed").length, 1);
  assert.equal(h.calls.some(call => call[0] === "ready" || call[0] === "retire"), false);
});

test("renderer crash during initial load retires the owned child without delivering a snapshot", () => {
  const h = harness(); h.create();
  const queued = h.contents.listeners("did-finish-load")[0];
  h.contents.emit("render-process-gone"); queued();
  assert.deepEqual(h.calls[h.calls.length - 2], ["retire", h.nativeWindow, "crash"]);
  assert.equal(h.calls.some(call => call[0] === "ready"), false);
});

test("a failed load retires its child and consumes the rejection", async () => {
  const h = harness(); let reject!: (error: Error) => void;
  h.state.load = new Promise<void>((_resolve, fail) => { reject = fail; }); h.create();
  reject(new Error("fixture load failed")); await Promise.resolve();
  assert.deepEqual(h.calls[h.calls.length - 2], ["retire", h.nativeWindow, "load"]);
  assert.equal(h.calls.some(call => call[0] === "ready"), false);
});

test("late load failure after close cannot retire another composer owner", async () => {
  const h = harness(); let reject!: (error: Error) => void;
  h.state.load = new Promise<void>((_resolve, fail) => { reject = fail; }); h.create(); h.window.emit("closed");
  reject(new Error("late failure")); await Promise.resolve();
  assert.equal(h.calls.some(call => call[0] === "retire"), false);
});
