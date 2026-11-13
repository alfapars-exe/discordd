import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { registerAppCommandIPC } from "./app-command-ipc";

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const calls: unknown[][] = [];
  const state = { version: "1.0.0", invalid: false, relaunchFails: false };
  registerAppCommandIPC({ handle: (channel, callback) => handlers.set(channel, callback) } satisfies Pick<IpcMain, "handle">, {
    getVersion: () => state.version,
    relaunch: () => { calls.push(["relaunch"]); if (state.relaunchFails) throw new Error("relaunch refused"); },
    quit: () => { calls.push(["quit"]); },
    writeClipboard: text => { calls.push(["clipboard", text]); },
    assertString: (value, name, max): asserts value is string => { calls.push(["validate", value, name, max]); if (state.invalid) throw new TypeError("invalid clipboard"); },
  });
  return { state, calls, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args) };
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
