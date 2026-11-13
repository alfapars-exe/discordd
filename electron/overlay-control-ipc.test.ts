import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { registerOverlayControlIPC } from "./overlay-control-ipc";

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc = { handle: (name, callback) => handlers.set(name, callback) } satisfies Pick<IpcMain, "handle">;
  const event = {} as IpcMainInvokeEvent;
  const calls: unknown[][] = [];
  const state = { trusted: true, accepted: false };
  registerOverlayControlIPC(ipc, {
    trusted: received => { assert.equal(received, event); calls.push(["trusted"]); if (!state.trusted) throw new Error("untrusted"); },
    resetLayout: () => { calls.push(["reset"]); return state.accepted; },
    lock: () => { calls.push(["lock"]); },
    shortcut: { setBinding: value => { calls.push(["binding", value]); return state.accepted; } },
    media: {
      open: (received, raw) => { calls.push(["open", received, raw]); return state.accepted; },
      send: (received, raw) => { calls.push(["send", received, raw]); return state.accepted; },
      viewport: (received, raw) => { calls.push(["viewport", received, raw]); return state.accepted; },
      setReady: (received, raw) => { calls.push(["ready", received, raw]); return state.accepted; },
      getAvailability: received => { calls.push(["availability", received]); return null; },
    },
  });
  return { calls, state, event, handlers, invoke: (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args) };
}

test("overlay layout and shortcut reject untrusted callers before domain effects", () => {
  const h = harness(); h.state.trusted = false;
  assert.throws(() => h.invoke("reset-overlay-layout"), /untrusted/);
  assert.throws(() => h.invoke("set-overlay-shortcut", null), /untrusted/);
  assert.deepEqual(h.calls, [["trusted"], ["trusted"]]);
});

test("overlay controls preserve owner acceptance and null shortcut locking order", () => {
  const h = harness();
  assert.equal(h.invoke("reset-overlay-layout"), false);
  const binding = { accelerator: "Alt+O" };
  assert.equal(h.invoke("set-overlay-shortcut", binding), false);
  assert.equal(h.invoke("set-overlay-shortcut", null), false);
  assert.deepEqual(h.calls, [["trusted"], ["reset"], ["trusted"], ["binding", binding], ["trusted"], ["binding", null], ["lock"]]);
  h.state.accepted = true;
  assert.equal(h.invoke("reset-overlay-layout"), true);
  assert.equal(h.invoke("set-overlay-shortcut", binding), true);
});

test("all media commands forward the original sender and unknown input to the broker", () => {
  const h = harness(); h.state.trusted = false;
  const raw = { arbitrary: true };
  for (const [channel, method] of [["open-overlay-media-lease", "open"], ["send-overlay-media", "send"], ["send-overlay-media-viewport", "viewport"], ["set-overlay-media-receiver-ready", "ready"]]) {
    assert.equal(h.invoke(channel, raw), false);
    assert.deepEqual(h.calls[h.calls.length - 1], [method, h.event, raw]);
    h.state.accepted = true;
    assert.equal(h.invoke(channel, raw), true);
    h.state.accepted = false;
  }
  assert.equal(h.invoke("get-overlay-media-availability"), null);
  assert.deepEqual(h.calls[h.calls.length - 1], ["availability", h.event]);
  assert.equal(h.handlers.size, 7);
});
