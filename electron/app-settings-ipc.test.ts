import test from "node:test";
import assert from "node:assert/strict";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { registerAppSettingsIPC } from "./app-settings-ipc";
import { DEFAULT_APP_SETTINGS } from "./settings";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
function harness() {
  const handlers = new Map<string, Handler>(), writes: unknown[][] = [], osWrites: unknown[] = [];
  const cached = { ...DEFAULT_APP_SETTINGS };
  const event = {} as IpcMainInvokeEvent;
  registerAppSettingsIPC({ handle: (name, callback) => { assert(!handlers.has(name)); handlers.set(name, callback); } } as Pick<IpcMain, "handle">, {
    getSettings: () => cached, setSetting: (...args) => { writes.push(args); },
    getLoginItemSettings: () => ({ openAtLogin: true }), setLoginItemSettings: value => { osWrites.push(value); },
  });
  return { handlers, writes, osWrites, cached, event };
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
