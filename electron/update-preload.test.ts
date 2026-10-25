import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

test("sandbox preload subscriptions preserve siblings and ignore queued callbacks after disposal", () => {
  const ipc = Object.assign(new EventEmitter(), { invoke: async () => undefined });
  let api!: Record<string, (callback: (value: unknown) => void) => () => void>;
  vm.runInNewContext(readFileSync(path.join(__dirname, "preload.js"), "utf8"), {
    exports: {},
    require: (name: string) => {
      assert.equal(name, "electron", "sandbox preload acquired a runtime dependency");
      return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name: string, value: typeof api) => { api = value; } } };
    },
  });
  for (const [method, channel] of [
    ["onMaximizedChange", "window-maximized-change"],
    ["onUpdateAvailable", "update-available"],
    ["onUpdateProgress", "update-progress"],
    ["onUpdateDownloaded", "update-downloaded"],
    ["onUpdateError", "update-error"],
  ]) {
    const first: unknown[] = [], second: unknown[] = [];
    const stopFirst = api[method]((value) => first.push(value));
    const queued = ipc.listeners(channel)[0];
    const stopSecond = api[method]((value) => second.push(value));
    ipc.emit(channel, {}, "first");
    stopFirst(); stopFirst();
    queued({}, "stale");
    ipc.emit(channel, {}, "second");
    assert.deepEqual(first, ["first"]);
    assert.deepEqual(second, ["first", "second"]);
    stopSecond();
    assert.equal(ipc.listenerCount(channel), 0);
  }
});
