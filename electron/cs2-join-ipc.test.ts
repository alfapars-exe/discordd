import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { registerCS2JoinIPC } from "./cs2-join-ipc";
const nonce = "00000000-0000-4000-8000-000000000001";
const context = { origin: "https://chat.example.test", ownerId: "owner", generation: 1, nonce };
function fixture(supported = true) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, raw: unknown) => unknown>();
  const sender = new EventEmitter(); let frame = {};
  const main = () => ({ sender, senderFrame: frame }) as unknown as IpcMainInvokeEvent;
  const api = registerCS2JoinIPC({ handle: (channel, callback) => { handlers.set(channel, callback); } } as Pick<IpcMain, "handle">, event => {
    if (event.sender !== sender || event.senderFrame !== frame) throw new Error("Untrusted sender");
  }, { supported, fetch: async () => { throw new Error("Unexpected fetch"); }, openExternal: async () => { throw new Error("Unexpected shell"); } });
  return { sender, main, api, handlers, replace: () => { frame = {}; } };
}
test("join IPC denies subframes and installs one lifecycle listener for trusted main only", () => {
  const f = fixture(); const sync = f.handlers.get("sync-game-join-context")!;
  assert.throws(() => sync({ ...f.main(), senderFrame: {} } as IpcMainInvokeEvent, context), /Untrusted/);
  assert.equal(f.sender.listenerCount("destroyed"), 0);
  const first = sync(f.main(), context); assert.deepEqual(sync(f.main(), context), first);
  assert.equal(f.sender.listenerCount("destroyed"), 1);
  f.sender.emit("did-start-navigation", {}, "", false, false); assert.deepEqual(sync(f.main(), context), first);
  f.sender.emit("did-start-navigation", {}, "", true, true); assert.deepEqual(sync(f.main(), context), first);
  f.sender.emit("did-start-navigation", {}, "", false, true); assert.deepEqual(sync(f.main(), context), { accepted: false, scopeNonce: null });
  f.sender.emit("did-finish-load"); assert.notDeepEqual(sync(f.main(), context), first);
  f.sender.emit("render-process-gone"); assert.deepEqual(sync(f.main(), context), { accepted: false, scopeNonce: null });
  f.sender.emit("did-finish-load"); const afterCrash = sync(f.main(), context); assert.notDeepEqual(afterCrash, first);
  f.sender.emit("destroyed"); assert.deepEqual(sync(f.main(), context), { accepted: false, scopeNonce: null });
  f.api.dispose();
});
test("old main frame identity cannot use new document scope; unsupported platform is explicit", async () => {
  const f = fixture(); const old = f.main(); f.handlers.get("sync-game-join-context")!(old, context); f.replace();
  assert.throws(() => f.handlers.get("launch-cs2-game-join")!(old, {}), /Untrusted/);
  const g = fixture(false);
  assert.deepEqual(g.handlers.get("sync-game-join-context")!(g.main(), context), { accepted: false, scopeNonce: null });
  assert.equal(await g.handlers.get("launch-cs2-game-join")!(g.main(), {}), "unavailable");
});
