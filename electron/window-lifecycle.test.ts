import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

type WindowModule = typeof import("./window");

function createHarness(closeToTray = true) {
  let window!: FakeWindow;
  const counts = { overlay: 0, hotkeys: 0 };
  class FakeWindow extends EventEmitter {
    destroyed = false;
    hidden = 0;
    width = 1280;
    height = 800;
    x = 0;
    y = 0;
    webContents = Object.assign(new EventEmitter(), {
      send: () => undefined,
      setWindowOpenHandler: () => undefined,
      toggleDevTools: () => undefined,
    });

    constructor(_options: Record<string, unknown>) { super(); window = this; }
    setPosition(x: number, y: number) { this.x = x; this.y = y; }
    setSize(width: number, height: number) { this.width = width; this.height = height; }
    loadURL() { return Promise.resolve(); }
    isMaximized() { return false; }
    getBounds() { return { x: this.x, y: this.y, width: this.width, height: this.height }; }
    getNormalBounds() { return this.getBounds(); }
    isDestroyed() { return this.destroyed; }
    hide() { this.hidden += 1; }
    show() {}
    maximize() {}
  }

  const requireActual = createRequire(__filename);
  const injectedRequire = (name: string) => {
    if (name === "electron") return {
      app: { isPackaged: false }, BrowserWindow: FakeWindow,
      Menu: { setApplicationMenu: () => undefined },
      screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
      shell: { openExternal: () => undefined },
    };
    if (name === "./settings") return {
      getSettings: () => ({ transparentBackground: false, startMinimized: false, closeToTray }),
      getWindowBounds: () => null,
      saveWindowBounds: () => undefined,
    };
    if (name === "./navigation-policy") return { isInternalNavigation: () => true };
    if (name === "./push-to-talk") return { shutdownGlobalHotkeys: () => { counts.hotkeys += 1; } };
    if (name === "./voice-overlay") return { closeVoiceOverlay: () => { counts.overlay += 1; } };
    return requireActual(name);
  };
  const api = {} as WindowModule;
  vm.runInNewContext(readFileSync(path.join(__dirname, "window.js"), "utf8"), {
    exports: api,
    __dirname,
    process: { env: { NODE_ENV: "test" } },
    require: injectedRequire,
  });
  api.createMainWindow();
  return { api, window, counts };
}

test("renderer crash tears down retained native overlay state and hotkeys", () => {
  const { window, counts } = createHarness();
  window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.deepEqual(counts, { overlay: 1, hotkeys: 1 });
});

test("only main-frame document navigation or reload closes the overlay", () => {
  const { window, counts } = createHarness();
  window.webContents.emit("did-start-navigation", {}, "app://hichat/#settings", true, true);
  window.webContents.emit("did-start-navigation", {}, "app://hichat/message", false, false);
  assert.equal(counts.overlay, 0, "same-document routes and subframe loads retain the overlay");
  window.webContents.emit("did-start-navigation", {}, "app://hichat/index.html", false, true);
  assert.equal(counts.overlay, 1, "a main-frame document load clears renderer-owned plaintext");
  assert.equal(counts.hotkeys, 0, "navigation teardown does not change global hotkey semantics");
});

test("close-to-tray retains the overlay, while actual window destruction closes it", () => {
  const { api, window, counts } = createHarness(true);
  let trayPrevented = false;
  window.emit("close", { preventDefault: () => { trayPrevented = true; } });
  assert.equal(trayPrevented, true);
  assert.equal(window.hidden, 1);
  assert.equal(counts.overlay, 0, "hiding to tray is not a renderer ownership boundary");

  api.setQuitting(true);
  let destructionPrevented = false;
  window.emit("close", { preventDefault: () => { destructionPrevented = true; } });
  assert.equal(destructionPrevented, false);
  window.destroyed = true;
  window.emit("closed");
  assert.equal(counts.overlay, 1);
  assert.equal(counts.hotkeys, 1);
  assert.equal(api.getMainWindow(), null);
});
