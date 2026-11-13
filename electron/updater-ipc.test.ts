import test from "node:test";
import assert from "node:assert/strict";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { registerUpdaterIPC } from "./updater-ipc";

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();
  const state = { checked: false, result: null as { updateInfo: unknown } | null | undefined, checkError: false, downloadError: false };
  const calls: unknown[][] = [];
  registerUpdaterIPC({ handle: (name, callback) => { assert(!handlers.has(name)); handlers.set(name, callback); } } as Pick<IpcMain, "handle">, {
    wasPrelaunchChecked: () => state.checked,
    checkForUpdates: async () => { calls.push(["check"]); if (state.checkError) throw new Error("provider"); return state.result; },
    downloadUpdate: async () => { calls.push(["download"]); if (state.downloadError) throw new Error("network"); },
    quitAndInstall: (...args) => { calls.push(["install", ...args]); },
  });
  return { state, calls, handlers, invoke: (name: string) => handlers.get(name)!({} as IpcMainInvokeEvent) };
}

test("updater IPC keeps channel names and reads live prelaunch state without starting an update", () => {
  const h = harness();
  assert.deepEqual([...h.handlers.keys()], ["was-update-checked", "check-update", "download-update", "install-update"]);
  assert.equal(h.invoke("was-update-checked"), false);
  h.state.checked = true;
  assert.equal(h.invoke("was-update-checked"), true);
  assert.deepEqual(h.calls, []);
});

test("update checks retain provider info and normalize absent or failed results to null", async () => {
  const h = harness(), info = { version: "2.0.0", files: [{ url: "installer.exe" }] };
  h.state.result = { updateInfo: info };
  assert.equal(await h.invoke("check-update"), info);
  for (const result of [null, undefined, { updateInfo: undefined }]) {
    h.state.result = result;
    assert.equal(await h.invoke("check-update"), null);
  }
  h.state.checkError = true;
  assert.equal(await h.invoke("check-update"), null);
  assert.deepEqual(h.calls, Array.from({ length: 5 }, () => ["check"]));
});

test("download failures return false and retries can succeed without installing", async () => {
  const h = harness();
  h.state.downloadError = true;
  assert.equal(await h.invoke("download-update"), false);
  h.state.downloadError = false;
  assert.equal(await h.invoke("download-update"), true);
  assert.deepEqual(h.calls, [["download"], ["download"]]);
});

test("installation preserves silent install and forced restart flags", () => {
  const h = harness();
  assert.equal(h.invoke("install-update"), undefined);
  assert.deepEqual(h.calls, [["install", true, true]]);
});
