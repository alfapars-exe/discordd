import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { registerCaptureCommandIPC } from "./capture-command-ipc";
import { registerGlobalShortcutIPC } from "./global-shortcut-ipc";

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc = { handle: (name, callback) => handlers.set(name, callback) } satisfies Pick<IpcMain, "handle">;
  const calls: unknown[][] = [];
  const state = { trusted: true, rejectInput: false, registrationResult: true };
  const event = {} as IpcMainInvokeEvent;
  const trusted = (received: IpcMainInvokeEvent) => { assert.equal(received, event); calls.push(["trusted"]); if (!state.trusted) throw new Error("untrusted"); };
  const start = Promise.resolve();
  const token = "12345678-1234-4234-8234-123456789abc";
  registerCaptureCommandIPC(ipc, trusted, {
    startCapture: () => { calls.push(["start"]); return start; },
    stopCapture: () => { calls.push(["stop"]); },
    getCaptureStatus: () => ({ state: "unavailable", reason: "helper_missing" }),
    startDiagnosticCapture: async () => token,
    stopDiagnosticCapture: value => { calls.push(["stopDiagnostic", value]); return value === token; },
  });
  registerGlobalShortcutIPC(ipc, {
    trusted,
    assertString: (value, name, max): asserts value is string => { calls.push(["validate", value, name, max]); if (state.rejectInput) throw new TypeError("invalid key"); },
    registerPTT: key => { calls.push(["ptt", key]); return state.registrationResult; },
    unregisterPTT: () => { calls.push(["unregisterPTT"]); },
    registerMuteHotkey: key => { calls.push(["mute", key]); return state.registrationResult; },
    unregisterMuteHotkey: () => { calls.push(["unregisterMute"]); },
  });
  return { state, calls, start, token, invoke: (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args) };
}

test("capture and PTT commands authorize their sender before invoking the owner", () => {
  const h = harness(); h.state.trusted = false;
  for (const channel of ["start-system-capture", "stop-system-capture", "register-ptt-shortcut", "unregister-ptt-shortcut"]) assert.throws(() => h.invoke(channel, "KeyV"), /untrusted/);
  assert.deepEqual(h.calls, Array.from({ length: 4 }, () => ["trusted"]));
});

test("capture commands preserve worker promises, status and diagnostic results", async () => {
  const h = harness();
  assert.equal(h.invoke("start-system-capture"), h.start);
  await h.start;
  assert.equal(h.invoke("stop-system-capture"), undefined);
  assert.deepEqual(h.invoke("get-system-capture-status"), { state: "unavailable", reason: "helper_missing" });
  assert.equal(await h.invoke("start-system-capture-diagnostic"), h.token);
  assert.equal(h.invoke("stop-system-capture-diagnostic", h.token), true);
  assert.equal(h.invoke("stop-system-capture-diagnostic", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), false);
});

test("diagnostic stop rejects malformed and non-v4 tokens before touching capture", () => {
  const h = harness();
  for (const value of [null, 42, "", "not-a-token", "12345678-1234-1234-8234-123456789abc", "12345678-1234-4234-1234-123456789abc"]) assert.throws(() => h.invoke("stop-system-capture-diagnostic", value), /token is invalid/);
  assert.deepEqual(h.calls, []);
});

test("shortcut registration delegates the 64-character bound and preserves native refusal", () => {
  const h = harness(); h.state.registrationResult = false;
  assert.equal(h.invoke("register-ptt-shortcut", "KeyV"), false);
  assert.equal(h.invoke("register-mute-hotkey-shortcut", "KeyM"), false);
  assert.deepEqual(h.calls, [["trusted"], ["validate", "KeyV", "PTT keyCode", 64], ["ptt", "KeyV"], ["validate", "KeyM", "mute hotkey keyCode", 64], ["mute", "KeyM"]]);
  h.calls.length = 0; h.state.rejectInput = true;
  for (const channel of ["register-ptt-shortcut", "register-mute-hotkey-shortcut"]) assert.throws(() => h.invoke(channel, {}), /invalid key/);
  assert.equal(h.calls.some(call => ["ptt", "mute"].includes(String(call[0]))), false);
});

test("shortcut cleanup delegates to existing hook owners without acquiring a new hook", () => {
  const h = harness();
  h.invoke("unregister-ptt-shortcut"); h.invoke("unregister-mute-hotkey-shortcut");
  assert.deepEqual(h.calls, [["trusted"], ["unregisterPTT"], ["unregisterMute"]]);
});
