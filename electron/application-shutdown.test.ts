import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createApplicationShutdown } from "./application-shutdown";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(stops: Array<() => Promise<void> | void | null>) {
  const calls: unknown[][] = [];
  let timeout: (() => void) | undefined;
  const handle = createApplicationShutdown({
    prepare: () => { calls.push(["prepare"]); },
    flushCookies: async () => { calls.push(["cookies"]); },
    resources: stops.map((stop, index) => ({ name: `resource-${index}`, stop })),
    quit: () => { calls.push(["quit"]); },
    report: (scope, reason) => { calls.push(["report", scope, reason]); },
    schedule: (callback, delay) => { timeout = callback; calls.push(["schedule", delay]); return {} as ReturnType<typeof setTimeout>; },
    cancel: () => { calls.push(["cancel"]); },
  });
  const request = () => { let prevented = false; handle({ preventDefault: () => { prevented = true; } }); return prevented; };
  return { calls, request, timeout: () => timeout!() };
}

test("repeated quit cannot bypass either native owner and preparation runs once", async () => {
  const capture = deferred(), ipc = deferred();
  const h = harness([() => capture.promise, () => ipc.promise]);
  assert.equal(h.request(), true); assert.equal(h.request(), true);
  capture.resolve(); await flush();
  assert.equal(h.calls.some(call => call[0] === "quit"), false);
  ipc.resolve(); await flush();
  assert.equal(h.calls.filter(call => call[0] === "quit").length, 1);
  assert.equal(h.calls.filter(call => call[0] === "prepare").length, 1);
  assert.equal(h.request(), false, "the resumed quit can proceed");
});

test("cleanup rejection is reported without skipping other owners or stranding quit", async () => {
  const pending = deferred();
  const h = harness([() => { throw new Error("private failure detail"); }, () => pending.promise]);
  h.request(); await flush();
  assert.deepEqual(h.calls.find(call => call[0] === "report"), ["report", "resource-0", "failed"]);
  assert.equal(JSON.stringify(h.calls).includes("private failure detail"), false);
  assert.equal(h.calls.some(call => call[0] === "quit"), false);
  pending.resolve(); await flush();
  assert.equal(h.request(), false);
});

test("deadline reports only pending owners and late completion cannot quit twice", async () => {
  const pending = deferred();
  const h = harness([() => null, () => pending.promise]);
  h.request(); await flush(); h.timeout();
  assert.deepEqual(h.calls.filter(call => call[0] === "report"), [["report", "resource-1", "timeout"]]);
  assert.ok(h.calls.some(call => call[0] === "schedule" && call[1] === 5000));
  pending.resolve(); await flush();
  assert.equal(h.calls.filter(call => call[0] === "quit").length, 1);
});

test("best-effort cookie persistence cannot hold native completion open", async () => {
  let quits = 0;
  const handle = createApplicationShutdown({ prepare: () => {}, flushCookies: () => new Promise(() => {}), resources: [], quit: () => { quits++; }, report: () => {} });
  handle({ preventDefault: () => {} }); await flush();
  assert.equal(quits, 1);
});

test("real main shutdown wiring prevents repeated quit and awaits IPC plus capture", async () => {
  const app = new EventEmitter();
  const capture = deferred(), ipc = deferred();
  let quits = 0, ipcStops = 0;
  const code = readFileSync(path.join(__dirname, "main.js"), "utf8");
  const start = code.includes("const handleShutdown =") ? code.lastIndexOf("const handleShutdown =") : code.lastIndexOf("let shutdownStarted =");
  assert.ok(start >= 0);
  vm.runInNewContext(code.slice(start), {
    electron_1: { app: Object.assign(app, { quit: () => { quits++; } }), session: { defaultSession: { cookies: { flushStore: async () => {} } } } },
    application_shutdown_1: { createApplicationShutdown },
    window_1: { setQuitting: () => {} }, voice_overlay_1: { closeVoiceOverlay: () => {} },
    push_to_talk_1: { shutdownGlobalHotkeys: () => {} }, audio_capture_1: { shutdownCapture: () => capture.promise },
    shutdownIPC: () => { ipcStops++; return ipc.promise; }, console,
  });
  try {
    for (let index = 0; index < 2; index++) {
      let prevented = false;
      app.emit("before-quit", { preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true, "a second quit must not bypass in-flight native cleanup");
    }
    capture.resolve(); await flush();
    assert.equal(quits, 0, "IPC cleanup must finish too");
    assert.equal(ipcStops, 1);
    ipc.resolve(); await flush();
    assert.equal(quits, 1);
  } finally { capture.resolve(); ipc.resolve(); await flush(); }
});

test("real IPC cleanup starts every owner once and still awaits tracker if a sibling fails", async () => {
  const code = readFileSync(path.join(__dirname, "ipc-handlers.js"), "utf8");
  const start = code.lastIndexOf("let cleanup = null;");
  const end = code.indexOf("\n}\nfunction isTrustedMainWindowSender", start);
  assert.ok(start >= 0 && end > start);
  const tracker = deferred();
  const calls: string[] = [];
  const dispose = vm.runInNewContext(`(function () { ${code.slice(start, end)} })()`, {
    gameJoin: { dispose: () => { calls.push("join"); throw new Error("private path"); } },
    stopOverlayMediaLifecycle: () => { calls.push("subscription"); },
    overlayMedia: { revoke: () => { calls.push("media"); } },
    overlayShortcut: { dispose: () => { calls.push("shortcut"); } },
    gameOverlay: { dispose: () => { calls.push("overlay"); } },
    registeredGames: { dispose: () => { calls.push("registry"); } },
    gameWindowTracker: { dispose: () => { calls.push("tracker"); return tracker.promise; } },
  }) as () => Promise<void>;
  const first = dispose(), second = dispose();
  assert.equal(first, second, "the IPC resource group has one completion owner");
  let finished = false;
  const observed = first.catch(error => { finished = true; assert.equal(error.message, "IPC cleanup failed"); });
  await flush();
  assert.deepEqual(calls, ["join", "subscription", "media", "shortcut", "overlay", "registry", "tracker"]);
  assert.equal(finished, false);
  tracker.resolve(); await observed;
  assert.equal(finished, true);
  assert.equal(dispose(), first);
});

test("relaunch IPC follows graceful quit instead of bypassing native cleanup with exit", () => {
  const code = readFileSync(path.join(__dirname, "ipc-handlers.js"), "utf8");
  const start = code.indexOf('electron_1.ipcMain.handle("relaunch"');
  const end = code.indexOf("\n    });", start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map<string, () => void>();
  const calls: string[] = [];
  vm.runInNewContext(code.slice(start, end + "\n    });".length), {
    electron_1: { ipcMain: { handle: (name: string, callback: () => void) => handlers.set(name, callback) },
      app: { relaunch: () => calls.push("relaunch"), quit: () => calls.push("quit"), exit: () => calls.push("forced-exit") } },
  });
  handlers.get("relaunch")!();
  assert.deepEqual(calls, ["relaunch", "quit"]);
});
