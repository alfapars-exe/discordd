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
    getWindow: () => ({ isDestroyed: () => false, webContents: {id:9,isDestroyed:()=>false, send: (channel: string, value: unknown) => sends.push([channel, value]) } }) as never,
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

test("scoped reserve-subscribe-start lease never steals active capture and legacy cleanup cannot stop it",async()=>{
 const f=setup(),id=f.worker.reserveLease(9,{kind:"guild",source:"guild-nonce"});assert.equal(f.spawned,0);assert.throws(()=>f.worker.reserveLease(9,{kind:"group",source:"other"}),/already in use/);
 await assert.rejects(f.worker.startLease(8,id),/no longer current/);assert.equal(f.spawned,0);
 const start=f.worker.startLease(9,id);assert.equal(f.worker.startLease(9,id),start);f.proc.writeHeader();await start;assert.equal(f.spawned,1);
 assert.equal(f.sends.some(([channel])=>channel==="capture-audio-header"),false);assert.equal(f.sends.some(([channel,value])=>channel==="system-capture-lease-event"&&(value as {leaseId:string;type:string}).leaseId===id&&(value as {type:string}).type==="header"),true);
 f.worker.stop();assert.equal(f.proc.killed,false);await assert.rejects(f.worker.start(),/already in use/);assert.equal(f.worker.releaseLease(8,id),false);assert.equal(f.worker.releaseLease(9,"other"),false);assert.equal(f.worker.status().state,"running");
 f.proc.stdout.emit("data",Buffer.alloc(8));f.flush();assert.equal(f.sends.some(([channel,value])=>channel==="system-capture-lease-event"&&(value as {type:string}).type==="data"),true);
 assert.equal(f.worker.releaseLease(9,id),true);assert.equal(f.proc.killed,true);const next=f.worker.reserveLease(9,{kind:"group",source:"new"});assert.notEqual(next,id);assert.equal(f.worker.releaseLease(9,id),false);assert.equal(f.worker.status().owner,"screen_share");f.worker.releaseLease(9,next);
});
test("retired sender cancels pending start and old header cannot reach replacement lease",async()=>{
 const f=setup(),id=f.worker.reserveLease(9,{kind:"p2p",source:"first"}),pending=f.worker.startLease(9,id);f.worker.retireSender(8);assert.equal(f.worker.status().state,"starting");f.worker.retireSender(9);await assert.rejects(pending,/cancelled/);const before=f.sends.length;f.proc.writeHeader();assert.equal(f.sends.length,before);const next=f.worker.reserveLease(9,{kind:"group",source:"replacement"});assert.equal(f.worker.releaseLease(9,id),false);const running=f.worker.startLease(9,next);f.proc.writeHeader();await running;assert.equal(f.worker.status().state,"running");f.worker.releaseLease(9,next);
});

test("leased guild retains existing diagnostic preemption while private shares cannot take another owner",async()=>{
 const f=setup(),diagnostic=f.worker.startDiagnostic();f.proc.writeHeader();const token=await diagnostic;assert.throws(()=>f.worker.reserveLease(9,{kind:"group",source:"private"}),/already in use/);assert.equal(f.proc.killed,false);const guild=f.worker.reserveLease(9,{kind:"guild",source:"guild"});assert.equal(f.proc.killed,true);assert.equal(f.worker.stopDiagnostic(token),false);f.worker.releaseLease(9,guild);
});
