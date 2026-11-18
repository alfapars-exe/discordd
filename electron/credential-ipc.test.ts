import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { registerCredentialIPC } from "./credential-ipc";
import { isTrustedVoiceOverlaySender, type VoiceOverlayMainWindow } from "./voice-overlay-contract";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
function harness() {
  const handlers = new Map<string, Handler>();
  const calls: unknown[][] = [];
  const webContents = { mainFrame: {} };
  let main: VoiceOverlayMainWindow | null = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  const response = { status: 200, body: { success: true, data: { access_token: "fixture-access" } } };
  registerCredentialIPC({ handle: (name, callback) => { assert(!handlers.has(name)); handlers.set(name, callback); } } as Pick<IpcMain, "handle">,
    value => { if (!isTrustedVoiceOverlaySender(value, main)) throw new Error("Untrusted IPC sender."); }, {
      save: (...args) => { calls.push(["save", ...args]); },
      load: () => { calls.push(["load"]); return { username: "fixture-user", password: "fixture-password", origin: "https://example.test" }; },
      clear: () => { calls.push(["clear"]); },
      login: async origin => { calls.push(["login", origin]); return response; },
    });
  return { handlers, calls, event, response, replaceMain: (value: VoiceOverlayMainWindow | null) => { main = value; } };
}

test("credential registrar preserves the four existing IPC channel names", () => {
  assert.deepEqual([...harness().handlers.keys()], ["save-credentials", "load-credentials", "login-with-saved-credentials", "clear-credentials"]);
});

test("every credential operation rejects foreign senders and subframes before touching storage or network", () => {
  const h = harness();
  for (const handler of h.handlers.values()) {
    for (const event of [{ ...h.event, sender: {} }, { ...h.event, senderFrame: {} }, { ...h.event, senderFrame: null }]) {
      assert.throws(() => handler(event as IpcMainInvokeEvent, null, null, null), /Untrusted IPC sender/);
    }
  }
  assert.equal(h.calls.length, 0);
});

test("credential ownership is checked again after main-window replacement or destruction", () => {
  const h = harness();
  for (const main of [null, { webContents: { mainFrame: {} }, isDestroyed: () => false },
    { webContents: h.event.sender as unknown as { mainFrame: unknown }, isDestroyed: () => true }]) {
    h.replaceMain(main);
    for (const handler of h.handlers.values()) assert.throws(() => handler(h.event, "user", "password", "https://example.test"), /Untrusted IPC sender/);
  }
  assert.equal(h.calls.length, 0);
});

test("credential saves retain field bounds and origin normalization", () => {
  const h = harness(), save = h.handlers.get("save-credentials")!;
  for (const args of [[null, "password", "https://example.test"], ["u".repeat(513), "password", "https://example.test"],
    ["user", {}, "https://example.test"], ["user", "p".repeat(4097), "https://example.test"],
    ["user", "password", null], ["user", "password", "https://user:password@example.test"], ["user", "password", "javascript:alert(1)"]]) {
    assert.throws(() => save(h.event, ...args));
  }
  assert.equal(h.calls.length, 0);
  save(h.event, "u".repeat(512), "p".repeat(4096), "https://EXAMPLE.test/path");
  assert.deepEqual(h.calls, [["save", "u".repeat(512), "p".repeat(4096), "https://example.test"]]);
});

test("credential loads expose only username and saved-login response contracts are preserved", async () => {
  const h = harness();
  assert.deepEqual(h.handlers.get("load-credentials")!(h.event), { username: "fixture-user" });
  assert.equal(await h.handlers.get("login-with-saved-credentials")!(h.event, "https://example.test"), h.response);
  assert.equal(h.handlers.get("clear-credentials")!(h.event), undefined);
  assert.deepEqual(h.calls, [["load"], ["login", "https://example.test"], ["clear"]]);
});
