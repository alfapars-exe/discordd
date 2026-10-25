import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAudioCaptureWorker } from "./audio-capture";

class FakeCapture extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
  writeHeader(overrides: Partial<{ rate: number; channels: number; bits: number; format: number }> = {}): void {
    const buffer = Buffer.alloc(12);
    buffer.writeUInt32LE(overrides.rate ?? 48000, 0);
    buffer.writeUInt16LE(overrides.channels ?? 2, 4);
    buffer.writeUInt16LE(overrides.bits ?? 32, 6);
    buffer.writeUInt32LE(overrides.format ?? 3, 8);
    this.stdout.emit("data", buffer);
  }
}

function setup(overrides: { exists?: boolean; platform?: string; startupTimeoutMs?: number } = {}) {
  const proc = new FakeCapture();
  const sends: Array<[string, unknown]> = [];
  let flush: (() => void) | null = null;
  let spawned = 0;
  const worker = createAudioCaptureWorker({
    platform: overrides.platform ?? "win32", processId: 123, exePath: () => "C:\\private\\audio-capture.exe",
    exists: () => overrides.exists ?? true,
    spawn: () => { spawned++; return proc as never; },
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel: string, value: unknown) => sends.push([channel, value]) } }) as never,
    log: () => {}, startupTimeoutMs: overrides.startupTimeoutMs ?? 100, shutdownTimeoutMs: 50,
    setTimeout, clearTimeout,
    setInterval: ((callback: (...args: never[]) => void) => { flush = callback as () => void; return {} as ReturnType<typeof setInterval>; }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });
  return { worker, proc, sends, flush: () => flush?.(), get spawned() { return spawned; } };
}

test("start resolves only after a complete valid audio header", async () => {
  const f = setup();
  let settled = false;
  const pending = f.worker.start().then(() => { settled = true; });
  assert.equal(settled, false);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(48000, 0); header.writeUInt16LE(2, 4); header.writeUInt16LE(32, 6); header.writeUInt32LE(3, 8);
  f.proc.stdout.emit("data", header.subarray(0, 7));
  assert.equal(settled, false);
  f.proc.stdout.emit("data", header.subarray(7));
  await pending;
  assert.equal(settled, true);
  assert.equal(f.sends.filter(([channel]) => channel === "capture-audio-header").length, 1);
  f.worker.stop();
});

test("events drained after an active child exits are ignored", async () => {
  const f = setup();
  const pending = f.worker.start();
  f.proc.writeHeader();
  await pending;
  f.proc.emit("exit", 1);
  f.proc.writeHeader();
  assert.equal(f.sends.filter(([channel]) => channel === "capture-audio-header").length, 1);
  assert.equal(f.sends.filter(([channel]) => channel === "capture-audio-stopped").length, 1);
});

test("PCM chunks split across timer flushes retain every whole frame byte-exactly", async () => {
  const f = setup();
  const pending = f.worker.start();
  f.proc.writeHeader();
  await pending;
  const expected = Buffer.from(Array.from({ length: 16 }, (_, index) => index + 1));
  let offset = 0;
  for (const length of [1, 3, 7, 5]) {
    f.proc.stdout.emit("data", expected.subarray(offset, offset + length));
    offset += length;
    f.flush();
  }
  const delivered = Buffer.concat(f.sends.filter(([channel]) => channel === "capture-audio-data").map(([, value]) => value as Buffer));
  assert.deepEqual(delivered, expected);
  assert.equal(delivered.length % 8, 0); // two complete stereo float32 frames
  f.worker.stop();
});

test("missing helper rejects without attempting spawn or exposing its path", async () => {
  const f = setup({ exists: false });
  await assert.rejects(f.worker.start(), /not installed/);
  assert.equal(f.spawned, 0);
});

test("spawn failure rejects with a safe error and notifies the renderer", async () => {
  const f = setup();
  const pending = f.worker.start();
  const error = Object.assign(new Error("spawn C:\\private\\audio-capture.exe denied"), { code: "EACCES" });
  f.proc.emit("error", error);
  await assert.rejects(pending, (reason: Error) => {
    assert.match(reason.message, /permission_denied/);
    assert.doesNotMatch(reason.message, /C:\\private/);
    return true;
  });
  assert.ok(f.sends.some(([channel, value]) => channel === "capture-audio-stopped" && value === undefined));
});

test("exit before ready rejects and marks the helper stopped", async () => {
  const f = setup();
  const pending = f.worker.start();
  f.proc.emit("exit", 2);
  await assert.rejects(pending, /exited_before_ready/);
  assert.ok(f.sends.some(([channel]) => channel === "capture-audio-stopped"));
});

test("startup timeout kills the child and rejects", async () => {
  const f = setup({ startupTimeoutMs: 5 });
  const pending = f.worker.start();
  await assert.rejects(pending, /startup_timeout/);
  assert.equal(f.proc.killed, true);
  f.proc.writeHeader(); // stale events after timeout must not notify a later renderer session
  assert.equal(f.sends.some(([channel]) => channel === "capture-audio-header"), false);
});

test("stop during startup rejects once and invalidates stale child events", async () => {
  const f = setup();
  const pending = f.worker.start();
  f.worker.stop();
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.proc.killed, true);
  f.proc.writeHeader();
  assert.equal(f.sends.some(([channel]) => channel === "capture-audio-header"), false);
});

test("invalid format is rejected instead of reported ready", async () => {
  const f = setup();
  const pending = f.worker.start();
  f.proc.writeHeader({ rate: 0 });
  await assert.rejects(pending, /invalid_audio_format/);
  assert.equal(f.sends.some(([channel]) => channel === "capture-audio-header"), false);
});

test("non-Windows start reports unsupported instead of succeeding as a no-op", async () => {
  const f = setup({ platform: "darwin" });
  await assert.rejects(f.worker.start(), /unavailable on this platform/);
  assert.equal(f.spawned, 0);
});

test("diagnostic capture is opt-in, owner-scoped, and never publishes PCM to screen-share listeners", async () => {
  const f = setup();
  assert.deepEqual(f.worker.status(), { state: "stopped" });
  const pending = f.worker.startDiagnostic();
  assert.deepEqual(f.worker.status(), { state: "starting", owner: "diagnostic" });
  f.proc.writeHeader();
  const token = await pending;
  assert.equal(f.worker.status().state, "running");
  assert.equal(f.worker.status().owner, "diagnostic");
  f.proc.stdout.emit("data", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  f.flush();
  assert.equal(f.sends.some(([channel]) => channel.startsWith("capture-audio-")), false);
  assert.equal(f.worker.stopDiagnostic("not-the-owner"), false);
  assert.equal(f.proc.killed, false);
  assert.equal(f.worker.stopDiagnostic(token), true);
  assert.equal(f.worker.status().state, "stopped");
  assert.equal(f.sends.some(([channel]) => channel.startsWith("capture-audio-")), false);
});

test("diagnostics cannot start during screen share and stale diagnostic stop cannot stop a takeover", async () => {
  const f = setup();
  const screenShare = f.worker.start();
  f.proc.writeHeader();
  await screenShare;
  await assert.rejects(f.worker.startDiagnostic(), /already in use/);
  assert.equal(f.worker.status().owner, "screen_share");
  assert.equal(f.sends.filter(([channel]) => channel === "capture-audio-header").length, 1);
  f.worker.stop();
  assert.equal(f.worker.status().state, "stopped");
});

test("screen share takes priority over a diagnostic and stale token cannot stop the new owner", async () => {
  const f = setup();
  const diagnostic = f.worker.startDiagnostic();
  f.proc.writeHeader();
  const token = await diagnostic;
  const screenShare = f.worker.start();
  assert.equal(f.worker.stopDiagnostic(token), false);
  assert.equal(f.worker.status().state, "starting");
  assert.equal(f.worker.status().owner, "screen_share");
  f.proc.writeHeader();
  await screenShare;
  assert.equal(f.worker.status().state, "running");
  assert.equal(f.sends.filter(([channel]) => channel === "capture-audio-header").length, 1);
  f.worker.stop();
});

test("status reports missing helpers and safe startup error reasons without leaking paths", async () => {
  const missing = setup({ exists: false });
  assert.deepEqual(missing.worker.status(), { state: "unavailable", reason: "helper_missing" });
  const failed = setup({ startupTimeoutMs: 5 });
  await assert.rejects(failed.worker.startDiagnostic(), /startup_timeout/);
  assert.deepEqual(failed.worker.status(), { state: "error", reason: "startup_timeout" });
});
