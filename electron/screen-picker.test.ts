import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

function fixture() {
  const ipc = new EventEmitter();
  const frame = {};
  const messages: string[] = [];
  const diagnostics: Array<{ phase: string; sourceKind?: string }> = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame, isDestroyed: () => false,
    send: (channel: string, value: { phase: string; sourceKind?: string }) => {
      messages.push(channel);
      if (channel === "screen-picker-diagnostic") diagnostics.push(value);
    },
  });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
  const source = { id: "screen:1", name: "screen", thumbnail: { isEmpty: () => true }, appIcon: null };
  let handler!: (request: { frame: object }, callback: (streams: { video?: typeof source }) => void) => Promise<void>;
  let query: () => Promise<typeof source[]> = async () => [source];
  const exports = {} as typeof import("./screen-picker");
  vm.runInNewContext(readFileSync(path.join(__dirname, "screen-picker.js"), "utf8"), {
    exports, console: { error() {} },
    setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) => {
      if (name === "electron") return { ipcMain: ipc, desktopCapturer: { getSources: () => query() }, session: { defaultSession: { setDisplayMediaRequestHandler: (value: typeof handler) => { handler = value; } } } };
      if (name === "./window") return { getMainWindow: () => window };
      if (name === "./picker-safe-mode") return { arePickerThumbnailsDisabled: () => true };
      throw new Error(name);
    },
  });
  exports.installScreenPicker();
  return { ipc, contents, window, frame, source, messages, diagnostics, timers, request: (callback: Parameters<typeof handler>[1], requestFrame = frame) => handler({ frame: requestFrame }, callback),
    event: { sender: contents, senderFrame: frame }, setQuery: (value: typeof query) => { query = value; } };
}

test("only one owner can receive a selection; foreign senders/frames cannot finish it", async () => {
  const f = fixture();
  const first: unknown[] = [], second: unknown[] = [];
  await f.request((value) => first.push(value));
  await f.request((value) => second.push(value));
  assert.equal(second.length, 1);
  assert.equal(Object.keys(second[0] as object).length, 0);
  f.ipc.emit("screen-picker-result", { sender: {}, senderFrame: f.frame }, "screen:1");
  f.ipc.emit("screen-picker-result", { sender: f.contents, senderFrame: {} }, "screen:1");
  assert.equal(first.length, 0);
  f.ipc.emit("screen-picker-result", f.event, "screen:1");
  assert.equal((first[0] as { video: unknown }).video, f.source);
  assert.equal(f.diagnostics.find((event) => event.phase === "result_received")?.sourceKind, "screen");
  assert.equal(f.ipc.listenerCount("screen-picker-result"), 0);
  assert.equal(f.ipc.listenerCount("screen-picker-refresh"), 0);
  assert.equal(f.timers.size, 0);
});

for (const termination of ["closed", "destroyed", "render-process-gone", "did-navigate", "timeout"]) {
  test(`${termination} settles once and releases all picker listeners/timers`, async () => {
    const f = fixture();
    const results: unknown[] = [];
    await f.request((value) => results.push(value));
    if (termination === "timeout") [...f.timers.values()].find((timer) => timer.delay === 120_000)!.callback();
    else (termination === "closed" ? f.window : f.contents).emit(termination);
    f.ipc.emit("screen-picker-result", f.event, "screen:1");
    assert.equal(results.length, 1);
    assert.equal(Object.keys(results[0] as object).length, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.contents.listenerCount("destroyed"), 0);
    assert.equal(f.ipc.listenerCount("screen-picker-result"), 0);
  });
}

test("a destroyed owner cannot be revived by a late native source query", async () => {
  const f = fixture();
  let resolve!: (sources: typeof f.source[]) => void;
  f.setQuery(() => new Promise((done) => { resolve = done; }));
  const results: unknown[] = [];
  const pending = f.request((value) => results.push(value));
  f.window.emit("closed");
  resolve([f.source]);
  await pending;
  assert.equal(results.length, 1);
  assert.ok(!f.messages.includes("show-screen-picker"));
  assert.equal(f.timers.size, 0);
});

test("a capture request from a subframe is rejected before querying sources", async () => {
  const f = fixture();
  f.setQuery(() => { throw new Error("must not query"); });
  const results: unknown[] = [];
  await f.request((value) => results.push(value), {});
  assert.equal(results.length, 1);
  assert.equal(f.timers.size, 0);
});

for (const phase of ["no_sources", "handler_error"]) {
  test(`${phase} retains the existing diagnostic contract and completes capture`, async () => {
    const f = fixture();
    f.setQuery(phase === "no_sources" ? async () => [] : async () => { throw new Error("controlled capture failure"); });
    const results: unknown[] = [];
    await f.request((value) => results.push(value));
    assert.equal(results.length, 1);
    assert.ok(f.diagnostics.some((event) => event.phase === phase));
    assert.equal(f.timers.size, 0);
  });
}
