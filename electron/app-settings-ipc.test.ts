import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { isTrustedVoiceOverlaySender } from "./voice-overlay-contract";
import { registerAppSettingsIPC } from "./app-settings-ipc";
import { DEFAULT_APP_SETTINGS } from "./settings";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
function harness() {
  const handlers = new Map<string, Handler>(), writes: unknown[][] = [], osWrites: unknown[] = [];
  const cached = { ...DEFAULT_APP_SETTINGS };
  const state = { destroyed: false, absent: false };
  const contents = { mainFrame: {} };
  const main = { isDestroyed: () => state.destroyed, webContents: contents };
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  registerAppSettingsIPC({ handle: (name, callback) => { assert(!handlers.has(name)); handlers.set(name, callback); } } as Pick<IpcMain, "handle">, {
    trusted: received => { if (!isTrustedVoiceOverlaySender(received, state.absent ? null : main)) throw new Error("Untrusted IPC sender."); },
    getSettings: () => cached, setSetting: (...args) => { writes.push(args); },
    getLoginItemSettings: () => ({ openAtLogin: true }), setLoginItemSettings: value => { osWrites.push(value); },
  });
  return { handlers, writes, osWrites, cached, event, state, contents };
}

test("app settings IPC retains channel names and refreshes cached auto-start from OS state", () => {
  const h = harness();
  assert.deepEqual([...h.handlers.keys()], ["get-app-settings", "set-app-setting"]);
  assert.equal(h.cached.openAtLogin, false);
  assert.equal(h.handlers.get("get-app-settings")!(h.event), h.cached);
  assert.equal(h.cached.openAtLogin, true);
  assert.equal(h.writes.length, 0);
});

test("app settings IPC accepts the existing boolean flags and updates OS only for auto-start", () => {
  const h = harness(), set = h.handlers.get("set-app-setting")!;
  for (const key of ["openAtLogin", "startMinimized", "closeToTray", "transparentBackground", "hardwareAcceleration"]) {
    for (const value of [true, false]) set(h.event, key, value);
  }
  assert.equal(h.writes.length, 10);
  assert.deepEqual(h.osWrites, [{ openAtLogin: true }, { openAtLogin: false }]);
});

test("app settings IPC rejects invalid fields and values before disk or OS mutation", () => {
  const h = harness(), set = h.handlers.get("set-app-setting")!;
  for (const [key, value] of [[null, true], ["unknown", true], ["diagnosticVerbose", true], ["closeToTray", null], ["openAtLogin", "yes"], ["hardwareAcceleration", 1]]) {
    assert.throws(() => set(h.event, key, value), TypeError);
  }
  assert.equal(h.writes.length, 0);
  assert.equal(h.osWrites.length, 0);
});

test("app settings IPC never accepts inherited Object property names as settings", () => {
  const h = harness(), set = h.handlers.get("set-app-setting")!;
  for (const key of ["constructor", "toString", "valueOf", "__proto__"]) assert.throws(() => set(h.event, key, true), TypeError);
  assert.equal(h.writes.length, 0);
  assert.equal(h.osWrites.length, 0);
});

test("settings mutations reject non-owner senders before validation, disk or OS writes", () => {
  const h = harness(), set = h.handlers.get("set-app-setting")!;
  for (const received of [
    { sender: {}, senderFrame: {} },
    { sender: h.contents, senderFrame: {} },
    { sender: h.contents, senderFrame: null },
  ]) {
    assert.throws(() => set(received as unknown as IpcMainInvokeEvent, "openAtLogin", true), /Untrusted IPC sender/);
    assert.throws(() => set(received as unknown as IpcMainInvokeEvent, "unknown", null), /Untrusted IPC sender/);
  }
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.osWrites, []);
});

test("retired settings windows and navigation frames cannot change persistent flags", () => {
  const h = harness(), set = h.handlers.get("set-app-setting")!;
  for (const unavailable of ["destroyed", "absent"] as const) {
    h.state[unavailable] = true;
    assert.throws(() => set(h.event, "openAtLogin", true), /Untrusted IPC sender/);
    h.state[unavailable] = false;
  }
  h.contents.mainFrame = {};
  assert.throws(() => set(h.event, "openAtLogin", true), /Untrusted IPC sender/);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.osWrites, []);
  set({ sender: h.contents, senderFrame: h.contents.mainFrame } as unknown as IpcMainInvokeEvent, "openAtLogin", false);
  assert.deepEqual(h.writes, [["openAtLogin", false]]);
  assert.deepEqual(h.osWrites, [{ openAtLogin: false }]);
});

test("actual settings composition wires sender authorization before native persistence", () => {
  const code = readFileSync(path.join(__dirname, "ipc-handlers.js"), "utf8");
  const start = code.indexOf("(0, app_settings_ipc_1.registerAppSettingsIPC)");
  const end = code.indexOf("\n    });", start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map<string, Handler>();
  const effects: unknown[][] = [];
  let accepted = false;
  vm.runInNewContext(code.slice(start, end + "\n    });".length), {
    app_settings_ipc_1: { registerAppSettingsIPC },
    electron_1: {
      ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler) },
      app: { getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: (value: unknown) => effects.push(["os", value]) },
    },
    settings_1: { getSettings: () => ({ ...DEFAULT_APP_SETTINGS }), setSetting: (...args: unknown[]) => effects.push(["disk", ...args]) },
    assertTrustedMainWindowSender: () => { effects.push(["trusted"]); if (!accepted) throw new Error("sender rejected"); },
  });
  const set = handlers.get("set-app-setting")!;
  const event = {} as IpcMainInvokeEvent;
  assert.throws(() => set(event, "openAtLogin", true), /sender rejected/);
  assert.deepEqual(effects, [["trusted"]]);
  effects.length = 0; accepted = true;
  set(event, "openAtLogin", true);
  assert.deepEqual(effects, [["trusted"], ["disk", "openAtLogin", true], ["os", { openAtLogin: true }]]);
});
