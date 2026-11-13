import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createUpdateInstallationGate } from "./update-installation";
import { startRuntimeUpdater } from "./runtime-updater";

function harness(packaged = true) {
  const sent: unknown[][] = [], tray: string[] = [], installed: boolean[][] = [];
  const timers = new Set<() => void>(), notifications: FakeNotification[] = [];
  let checks = 0, downloaded = 0;
  const network = { failed: false };
  const requestUpdateInstallation = createUpdateInstallationGate();
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: async () => { checks++; if (network.failed) throw new Error("offline"); },
    quitAndInstall: (...args: boolean[]) => { installed.push(args); },
  });
  class FakeNotification extends EventEmitter {
    shown = false;
    constructor(public options: Record<string, unknown>) { super(); notifications.push(this); }
    show() { this.shown = true; }
  }
  const app = Object.assign(new EventEmitter(), { isPackaged: packaged });
  const exports = {} as typeof import("./auto-updater");
  vm.runInNewContext(readFileSync(path.join(__dirname, "auto-updater.js"), "utf8"), {
    exports, __dirname, console,
    setInterval: (callback: () => void, delay: number) => { assert.equal(delay, 300_000); timers.add(callback); return callback; },
    clearInterval: (callback: () => void) => { timers.delete(callback); },
    require: (name: string) => {
      if (name === "electron") return { app, Notification: FakeNotification };
      if (name === "electron-updater") return { autoUpdater: updater };
      if (name === "path") return path;
      if (name === "./update-installation") return { requestUpdateInstallation };
      if (name === "./runtime-updater") return { startRuntimeUpdater };
      if (name === "./window") return { getMainWindow: () => ({ webContents: { send: (...args: unknown[]) => { sent.push(args); } } }), setUpdateDownloaded: () => { downloaded++; } };
      if (name === "./tray") return { setTrayUpdateReady: (version: string) => { tray.push(version); } };
      throw new Error(`Unexpected updater dependency: ${name}`);
    },
  });
  return { api: exports, updater, app, sent, tray, installed, timers, notifications, network, checks: () => checks, downloaded: () => downloaded };
}

test("repeated updater setup owns one subscription set, poller and downloaded notification", () => {
  const h = harness();
  h.api.setupAutoUpdater(); h.api.setupAutoUpdater();
  for (const event of ["update-available", "download-progress", "update-downloaded", "error"]) assert.equal(h.updater.listenerCount(event), 1, event);
  assert.equal(h.timers.size, 1);
  assert.equal(h.checks(), 1);
  h.updater.emit("update-downloaded", { version: "2.0.0" });
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.tray, ["2.0.0"]);
  assert.equal(h.downloaded(), 1);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].shown, true);
  h.notifications[0].emit("click");
  assert.deepEqual(h.installed, [[true, true]]);
});

test("development setup does not subscribe, poll or mark a check complete", () => {
  const h = harness(false);
  h.api.setupAutoUpdater();
  assert.equal(h.api.wasPrelaunchChecked(), false);
  assert.equal(h.updater.eventNames().length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.checks(), 0);
});

test("shutdown retires owned polling and callbacks without removing sibling subscriptions", () => {
  const h = harness();
  let siblingCalls = 0;
  const sibling = () => { siblingCalls++; };
  h.updater.on("update-available", sibling);
  h.api.setupAutoUpdater();
  const queuedAvailable = h.updater.listeners("update-available")[1];
  const queuedProgress = h.updater.listeners("download-progress")[0];
  const queuedDownloaded = h.updater.listeners("update-downloaded")[0];
  const queuedError = h.updater.listeners("error")[0];
  const queuedPoll = [...h.timers][0];
  h.app.emit("will-quit"); h.app.emit("will-quit");
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.updater.listeners("update-available"), [sibling]);
  assert.equal(h.updater.listenerCount("download-progress"), 0);
  assert.equal(h.updater.listenerCount("update-downloaded"), 0);
  assert.equal(h.updater.listenerCount("error"), 0);
  queuedAvailable({ version: "late" }); queuedPoll();
  queuedProgress({ percent: 42 }); queuedDownloaded({ version: "late" }); queuedError(new Error("late"));
  h.updater.emit("update-available", { version: "sibling" });
  assert.equal(h.sent.length, 0);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.checks(), 1);
  assert.equal(siblingCalls, 1);
});

test("offline runtime checks settle silently and polling can recover", async () => {
  const h = harness(); h.network.failed = true;
  h.api.setupAutoUpdater();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.checks(), 1);
  h.network.failed = false;
  for (const poll of h.timers) poll();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.checks(), 2);
  assert.equal(h.sent.length, 0);
});

test("repeated notification clicks request installation only once", () => {
  const h = harness(); h.api.setupAutoUpdater();
  h.updater.emit("update-downloaded", { version: "2.0.0" });
  h.notifications[0].emit("click");
  h.notifications[0].emit("click");
  h.updater.emit("update-downloaded", { version: "2.0.0" });
  h.notifications[1].emit("click");
  assert.deepEqual(h.installed, [[true, true]]);
});

test("runtime events retain public channels and the poller performs another check", () => {
  const h = harness(); h.api.setupAutoUpdater();
  const info = { version: "2.0.0" }, progress = { percent: 42 };
  h.updater.emit("update-available", info);
  h.updater.emit("download-progress", progress);
  h.updater.emit("error", new Error("offline"));
  assert.deepEqual(h.sent, [["update-available", info], ["update-progress", progress], ["update-error", "offline"]]);
  for (const poll of h.timers) poll();
  assert.equal(h.checks(), 2);
});
