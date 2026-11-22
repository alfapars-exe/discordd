import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IpcMain, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { createApiRequestCancellation, type ApiRequestOwner } from "./api-request-cancellation";
import { registerApiRequestIPC } from "./api-request-ipc";
import { isTrustedVoiceOverlaySender } from "./voice-overlay-contract";

const binding = { url: "app://hichat/api/servers/a/voice/token", method: "POST", upstream: "https://example.test" };
function owner() {
  const sender = Object.assign(new EventEmitter(), { mainFrame: {} as WebFrameMain, isDestroyed: () => false });
  return { sender: sender as unknown as WebContents, frame: sender.mainFrame };
}

test("request leases bind endpoint/method/upstream and cannot be replayed or cancelled by another owner", () => {
  const requests = createApiRequestCancellation(), a = owner(), b = owner();
  const id = requests.reserve(a, binding);
  assert.throws(() => requests.cancel(b, id), /owner mismatch/);
  for (const change of [{ method: "GET" }, { url: "app://hichat/api/elsewhere" }, { upstream: "https://other.test" }]) {
    assert.throws(() => requests.claim(id, { ...binding, ...change }), /unavailable/);
  }
  const lease = requests.claim(id, binding);
  assert.throws(() => requests.claim(id, binding), /unavailable/);
  assert.equal(lease.signal.aborted, false);
  assert.equal(requests.cancel(a, id), true);
  assert.equal(lease.signal.aborted, true);
  assert.equal(requests.size, 0);
  assert.equal(requests.cancel(a, id), false);
  assert.throws(() => requests.claim(id, binding), /unavailable/);
});

test("bounds registrations and retires an abandoned reserve before dispatch", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = createApiRequestCancellation(1, 10_000), a = owner();
  const id = requests.reserve(a, binding);
  assert.throws(() => requests.reserve(a, binding), /Too many/);
  t.mock.timers.tick(10_000);
  assert.equal(requests.size, 0);
  assert.throws(() => requests.claim(id, binding), /unavailable/);
  const fresh = requests.reserve(a, binding), lease = requests.claim(fresh, binding);
  t.mock.timers.tick(10_000);
  assert.equal(lease.signal.aborted, false); // active body is owned until completion
  lease.finish(); assert.equal(requests.size, 0);
  requests.dispose();
});

test("cancel before dispatch and owner retirement prevent any later claim", () => {
  const requests = createApiRequestCancellation(), a = owner();
  const pending = requests.reserve(a, binding);
  requests.cancel(a, pending);
  assert.throws(() => requests.claim(pending, binding), /unavailable/);
  const active = requests.claim(requests.reserve(a, binding), binding);
  requests.retire(a.sender);
  assert.equal(active.signal.aborted, true);
  assert.equal(requests.size, 0);
});

test("request IPC uses trusted main-frame checks and retires only its own lifecycle listeners", () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>(), a = owner(), requests = createApiRequestCancellation();
  const main = { isDestroyed: () => false, webContents: a.sender };
  const ipc = { handle: (name: string, fn: Handler) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) } as unknown as Pick<IpcMain, "handle" | "removeHandler">;
  const trusted = (event: IpcMainInvokeEvent) => { if (!isTrustedVoiceOverlaySender(event, main)) throw Error("Untrusted IPC sender"); };
  const dispose = registerApiRequestIPC(ipc, { trusted, requests });
  const event = { sender: a.sender, senderFrame: a.frame } as IpcMainInvokeEvent;
  const reserve = handlers.get("reserve-api-request")!, cancel = handlers.get("cancel-api-request")!;
  for (const bad of [{ sender: owner().sender, senderFrame: a.frame }, { sender: a.sender, senderFrame: {} }, { sender: a.sender, senderFrame: null }]) {
    assert.throws(() => reserve(bad as IpcMainInvokeEvent, binding), /Untrusted/);
    assert.throws(() => cancel(bad as IpcMainInvokeEvent, "invalid"), /Untrusted/);
  }
  const sibling = () => {};
  a.sender.on("destroyed", sibling);
  for (const kind of ["navigation", "crash", "destruction"]) {
    const id = reserve(event, binding) as string, lease = requests.claim(id, binding);
    a.sender.emit("did-start-navigation", {}, "app://hichat/#route", true, true);
    assert.equal(lease.signal.aborted, false);
    if (kind === "navigation") a.sender.emit("did-start-navigation", {}, "app://hichat/", false, true);
    if (kind === "crash") a.sender.emit("render-process-gone");
    if (kind === "destruction") a.sender.emit("destroyed");
    assert.equal(lease.signal.aborted, true);
  }
  const last = requests.claim(reserve(event, binding) as string, binding);
  dispose();
  assert.equal(last.signal.aborted, true);
  assert.equal(handlers.size, 0);
  assert.deepEqual(a.sender.listeners("destroyed"), [sibling]);
  assert.equal(a.sender.listenerCount("did-start-navigation"), 0);
});

test("a previous document cannot claim or cancel a new document's registered request", () => {
  const requests = createApiRequestCancellation(), a = owner();
  const old = requests.reserve(a, binding);
  Object.assign(a.sender, { mainFrame: {} });
  assert.throws(() => requests.claim(old, binding), /unavailable/);
  const next: ApiRequestOwner = { sender: a.sender, frame: a.sender.mainFrame };
  const fresh = requests.reserve(next, binding);
  assert.throws(() => requests.cancel(a, fresh), /owner mismatch/);
  requests.dispose();
});
