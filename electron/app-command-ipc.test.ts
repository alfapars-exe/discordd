import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { isTrustedVoiceOverlaySender } from "./voice-overlay-contract";
import { registerAppCommandIPC } from "./app-command-ipc";

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const calls: unknown[][] = [];
  const state = { version: "1.0.0", invalid: false, relaunchFails: false, destroyed: false, absent: false };
  const contents = { mainFrame: {} };
  const main = { isDestroyed: () => state.destroyed, webContents: contents };
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  registerAppCommandIPC({ handle: (channel, callback) => handlers.set(channel, callback) } satisfies Pick<IpcMain, "handle">, {
    trusted: received => { if (!isTrustedVoiceOverlaySender(received, state.absent ? null : main)) throw new Error("Untrusted IPC sender."); },
    getVersion: () => state.version,
    relaunch: () => { calls.push(["relaunch"]); if (state.relaunchFails) throw new Error("relaunch refused"); },
    quit: () => { calls.push(["quit"]); },
    writeClipboard: text => { calls.push(["clipboard", text]); },
    assertString: (value, name, max): asserts value is string => { calls.push(["validate", value, name, max]); if (state.invalid) throw new TypeError("invalid clipboard"); },
  });
  return { state, calls, contents, event, invokeFrom: (received: IpcMainInvokeEvent, channel: string, ...args: unknown[]) => handlers.get(channel)!(received, ...args), invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args) };
}

test("version reads delegate to the app without caching", () => {
  const h = harness(); assert.equal(h.invoke("get-version"), "1.0.0");
  h.state.version = "2.0.0"; assert.equal(h.invoke("get-version"), "2.0.0");
});

test("relaunch is scheduled before graceful quit and failure cannot quit an unscheduled app", () => {
  const h = harness(); h.invoke("relaunch");
  assert.deepEqual(h.calls, [["relaunch"], ["quit"]]);
  h.calls.length = 0; h.state.relaunchFails = true;
  assert.throws(() => h.invoke("relaunch"), /relaunch refused/);
  assert.deepEqual(h.calls, [["relaunch"]]);
});

test("clipboard validates the existing 10 MiB string bound before writing unmodified text", () => {
  const h = harness(); h.invoke("write-clipboard", "  fixture\ntext  ");
  assert.deepEqual(h.calls, [["validate", "  fixture\ntext  ", "clipboard text", 10485760], ["clipboard", "  fixture\ntext  "]]);
  h.calls.length = 0; h.state.invalid = true;
  assert.throws(() => h.invoke("write-clipboard", {}), /invalid clipboard/);
  assert.equal(h.calls.some(call => call[0] === "clipboard"), false);
});

test("app mutations reject foreign windows and frames before validation or effects", () => {
  const h = harness();
  const events = [
    { sender: {}, senderFrame: {} },
    { sender: h.contents, senderFrame: {} },
    { sender: h.contents, senderFrame: null },
  ];
  for (const received of events) {
    assert.equal(h.invokeFrom(received as unknown as IpcMainInvokeEvent, "get-version"), h.state.version);
    for (const channel of ["relaunch", "write-clipboard"]) {
      assert.throws(() => h.invokeFrom(received as unknown as IpcMainInvokeEvent, channel, "fixture"), /Untrusted IPC sender/);
    }
  }
  assert.deepEqual(h.calls, []);
});

test("retired windows and previous main frames cannot mutate the app", () => {
  const h = harness();
  for (const unavailable of ["destroyed", "absent"] as const) {
    h.state[unavailable] = true;
    assert.throws(() => h.invoke("relaunch"), /Untrusted IPC sender/);
    assert.throws(() => h.invoke("write-clipboard", "fixture"), /Untrusted IPC sender/);
    h.state[unavailable] = false;
  }
  h.contents.mainFrame = {};
  assert.throws(() => h.invoke("relaunch"), /Untrusted IPC sender/);
  assert.throws(() => h.invoke("write-clipboard", "fixture"), /Untrusted IPC sender/);
  assert.deepEqual(h.calls, []);
  h.invokeFrom({ sender: h.contents, senderFrame: h.contents.mainFrame } as unknown as IpcMainInvokeEvent, "relaunch");
  assert.deepEqual(h.calls, [["relaunch"], ["quit"]]);
});
