import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { DiagnosticEntry } from "./diagnostic-log";
import { registerDiagnosticIPC } from "./diagnostic-ipc";

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const events = new Map<string, (event: IpcMainEvent, raw: unknown) => void>();
  const calls: unknown[][] = [], entries: DiagnosticEntry[] = [], data = Buffer.from("fixture");
  const state = { save: { canceled: false, filePath: "C:/fixture/diagnostic.JSON.GZ" }, dump: "C:/fixture/crash.dmp" as string | null, verbose: false, copyFails: false, writeFails: false, buildFails: false };
  const crash = { reason: "fixture" }, trace = { saved: true, path: "fixture-trace" };
  registerDiagnosticIPC({
    handle: (name, callback) => { assert(!handlers.has(name)); handlers.set(name, callback); },
    on(name, callback) { assert(!events.has(name)); events.set(name, callback); return this; },
  } as Pick<IpcMain, "handle" | "on">, {
    consumeLastCrash: () => crash,
    appendDiagnostic: entry => { entries.push(entry); },
    buildUploadBytes: async () => { calls.push(["build"]); if (state.buildFails) throw new Error("build failed"); return data; },
    bundleBaseName: () => "hichat-diagnostics", now: () => new Date(2026, 10, 13, 12, 34, 56),
    showSaveDialog: async options => { calls.push(["dialog", options]); return state.save; },
    writeFile: async (...args) => { calls.push(["write", ...args]); if (state.writeFails) throw new Error("write failed"); },
    copyFile: async (...args) => { calls.push(["copy", ...args]); if (state.copyFails) throw new Error("copy failed"); },
    newestCrashDumpFullPath: () => { calls.push(["dump"]); return state.dump; },
    openLogs: async () => "shell-result", isVerbose: () => state.verbose,
    persistVerbose: value => { calls.push(["persist", value]); state.verbose = value; },
    setVerbose: value => { calls.push(["live", value]); },
    capturePerformanceTrace: async () => trace, cancelPerformanceTrace: async () => true,
  });
  return { state, calls, entries, data, crash, trace, handlers, events,
    invoke: (name: string, ...args: unknown[]) => handlers.get(name)!({} as IpcMainInvokeEvent, ...args),
    log: (raw: unknown) => events.get("diagnostic-log")!({} as IpcMainEvent, raw) };
}

test("diagnostic IPC keeps channel inventory, binary upload filename and adapter results", async () => {
  const h = harness();
  assert.deepEqual([...h.handlers.keys()], ["consume-last-crash", "build-diagnostic-upload", "export-diagnostics", "open-logs-dir", "get-diagnostic-verbose", "set-diagnostic-verbose", "capture-performance-trace", "cancel-performance-trace"]);
  assert.deepEqual([...h.events.keys()], ["diagnostic-log"]);
  assert.deepEqual(await h.invoke("build-diagnostic-upload"), { filename: "hichat-diagnostics-20261113-123456.json.gz", data: h.data });
  assert.equal(h.invoke("consume-last-crash"), h.crash);
  assert.equal(await h.invoke("capture-performance-trace"), h.trace);
  assert.equal(await h.invoke("cancel-performance-trace"), true);
  assert.equal(await h.invoke("open-logs-dir"), "shell-result");
});

test("renderer log input limits and source coercion run before append", () => {
  const h = harness();
  for (const raw of [null, undefined, 1, "text", {}, { msg: "" }, { msg: false }, { msg: "x".repeat(2001) }]) h.log(raw);
  assert.equal(h.entries.length, 0);
  const meta = { detail: "fixture" };
  for (const level of ["info", "warn", "error"] as const) h.log({ msg: "x".repeat(2000), level, source: "native", category: "x".repeat(64), meta });
  assert.deepEqual(h.entries.map(entry => [entry.level, entry.source, entry.category?.length, entry.meta]), [["info", "renderer", 64, meta], ["warn", "renderer", 64, meta], ["error", "renderer", 64, meta]]);
  h.log({ msg: "valid", level: "fatal", category: "x".repeat(65), meta: [] });
  assert.deepEqual(h.entries[3], { msg: "valid", level: "info", source: "renderer", category: "", meta: undefined });
});

test("cancelled or empty export choices never write a bundle or inspect crash dumps", async () => {
  for (const save of [{ canceled: true, filePath: "ignored" }, { canceled: false, filePath: "" }]) {
    const h = harness(); h.state.save = save;
    assert.deepEqual(await h.invoke("export-diagnostics"), { saved: false });
    assert.deepEqual(h.calls.map(call => call[0]), ["build", "dialog"]);
  }
});

test("export writes the chosen bundle before copying its optional crash dump", async () => {
  const h = harness();
  assert.deepEqual(await h.invoke("export-diagnostics"), { saved: true, path: h.state.save.filePath, dumpCopied: true });
  assert.deepEqual(h.calls, [["build"], ["dialog", { defaultPath: "hichat-diagnostics-20261113-123456.json.gz", filters: [{ name: "Diagnostics", extensions: ["gz"] }] }], ["write", h.state.save.filePath, h.data], ["dump"], ["copy", h.state.dump, "C:/fixture/diagnostic.dmp"]]);
});

test("a missing or failed optional dump never invalidates the saved bundle", async () => {
  for (const copyFails of [false, true]) {
    const h = harness(); h.state.copyFails = copyFails; if (!copyFails) h.state.dump = null;
    assert.deepEqual(await h.invoke("export-diagnostics"), { saved: true, path: h.state.save.filePath, dumpCopied: false });
    assert.equal(h.calls.filter(call => call[0] === "copy").length, copyFails ? 1 : 0);
  }
});

test("bundle build and write failures propagate without continuing export side effects", async () => {
  const build = harness(); build.state.buildFails = true;
  await assert.rejects(async () => build.invoke("export-diagnostics"), /build failed/);
  assert.deepEqual(build.calls, [["build"]]);
  const write = harness(); write.state.writeFails = true;
  await assert.rejects(async () => write.invoke("export-diagnostics"), /write failed/);
  assert.deepEqual(write.calls.map(call => call[0]), ["build", "dialog", "write"]);
});

test("verbose settings validate before persistence and apply live after persistence", () => {
  const h = harness(); assert.equal(h.invoke("get-diagnostic-verbose"), false);
  for (const value of [null, 1, "false", {}]) assert.throws(() => h.invoke("set-diagnostic-verbose", value), /value must be a boolean/);
  assert.deepEqual(h.calls, []);
  h.invoke("set-diagnostic-verbose", true); h.invoke("set-diagnostic-verbose", false);
  assert.deepEqual(h.calls, [["persist", true], ["live", true], ["persist", false], ["live", false]]);
});
