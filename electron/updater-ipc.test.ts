import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { isTrustedVoiceOverlaySender } from "./voice-overlay-contract";
import { registerUpdaterIPC } from "./updater-ipc";

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();
  const state = { checked: false, result: null as { updateInfo: unknown } | null | undefined, checkError: false, downloadError: false, destroyed: false, absent: false };
  const contents = { mainFrame: {} };
  const main = { isDestroyed: () => state.destroyed, webContents: contents };
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  const calls: unknown[][] = [];
  registerUpdaterIPC({ handle: (name, callback) => { assert(!handlers.has(name)); handlers.set(name, callback); } } as Pick<IpcMain, "handle">, {
    trusted: received => { if (!isTrustedVoiceOverlaySender(received, state.absent ? null : main)) throw new Error("Untrusted IPC sender."); },
    wasPrelaunchChecked: () => state.checked,
    checkForUpdates: async () => { calls.push(["check"]); if (state.checkError) throw new Error("provider"); return state.result; },
    downloadUpdate: async () => { calls.push(["download"]); if (state.downloadError) throw new Error("network"); },
    quitAndInstall: (...args) => { calls.push(["install", ...args]); },
  });
  return { state, calls, handlers, contents, event, invokeFrom: (received: IpcMainInvokeEvent, name: string) => handlers.get(name)!(received), invoke: (name: string) => handlers.get(name)!(event) };
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

async function expectUpdateDenied(h: ReturnType<typeof harness>, event: IpcMainInvokeEvent) {
  await assert.rejects(async () => h.invokeFrom(event, "check-update"), /Untrusted IPC sender/);
  await assert.rejects(async () => h.invokeFrom(event, "download-update"), /Untrusted IPC sender/);
  assert.throws(() => h.invokeFrom(event, "install-update"), /Untrusted IPC sender/);
}

test("foreign renderer update commands reject instead of normalizing authorization errors", async () => {
  const h = harness();
  for (const event of [
    { sender: {}, senderFrame: {} },
    { sender: h.contents, senderFrame: {} },
    { sender: h.contents, senderFrame: null },
  ]) {
    await expectUpdateDenied(h, event as unknown as IpcMainInvokeEvent);
  }
  assert.deepEqual(h.calls, []);
});

test("old updater frames and retired main windows cannot check, download or install", async () => {
  const h = harness();
  for (const unavailable of ["destroyed", "absent"] as const) {
    h.state[unavailable] = true;
    await expectUpdateDenied(h, h.event);
    h.state[unavailable] = false;
  }
  h.contents.mainFrame = {};
  await expectUpdateDenied(h, h.event);
  assert.deepEqual(h.calls, []);
  h.invokeFrom({ sender: h.contents, senderFrame: h.contents.mainFrame } as unknown as IpcMainInvokeEvent, "install-update");
  assert.deepEqual(h.calls, [["install", true, true]]);
});

test("actual updater composition authorizes before provider or installer effects", async () => {
  const code = readFileSync(path.join(__dirname, "ipc-handlers.js"), "utf8");
  const start = code.indexOf("(0, updater_ipc_1.registerUpdaterIPC)");
  const end = code.indexOf("\n    });", start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();
  const effects: string[] = [];
  const event = {} as IpcMainInvokeEvent;
  let accepted = false;
  vm.runInNewContext(code.slice(start, end + "\n    });".length), {
    updater_ipc_1: { registerUpdaterIPC },
    electron_1: { ipcMain: { handle: (name: string, handler: (event: IpcMainInvokeEvent) => unknown) => handlers.set(name, handler) } },
    auto_updater_1: { wasPrelaunchChecked: () => false },
    electron_updater_1: { autoUpdater: {
      checkForUpdates: async () => { effects.push("check"); return null; },
      downloadUpdate: async () => { effects.push("download"); },
      quitAndInstall: () => { effects.push("install"); },
    } },
    update_installation_1: { requestUpdateInstallation: (install: () => void) => install() },
    assertTrustedMainWindowSender: (received: IpcMainInvokeEvent) => { assert.equal(received, event); if (!accepted) throw new Error("sender rejected"); },
  });
  await assert.rejects(async () => handlers.get("check-update")!(event), /sender rejected/);
  await assert.rejects(async () => handlers.get("download-update")!(event), /sender rejected/);
  assert.throws(() => handlers.get("install-update")!(event), /sender rejected/);
  assert.deepEqual(effects, []);
  accepted = true;
  await handlers.get("check-update")!(event);
  await handlers.get("download-update")!(event);
  handlers.get("install-update")!(event);
  assert.deepEqual(effects, ["check", "download", "install"]);
});
