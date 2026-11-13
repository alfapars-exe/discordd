import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { registerRegisteredGamesIPC } from "./registered-games-ipc";

function harness(platform: NodeJS.Platform = "win32", overlaySupported = true) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const calls: unknown[][] = [];
  const state = { trusted: true, removed: true, canceled: false, paths: ["C:/fixture/game.exe"] };
  const game = { id: "game", displayName: "Game", executableName: "game.exe", shareAllowed: false, joinAdapter: "none" as const, overlayAllowed: false, availability: "available" as const, running: false, lastSeenAt: null };
  const event = {} as IpcMainInvokeEvent;
  registerRegisteredGamesIPC({ handle: (channel, callback) => handlers.set(channel, callback) } satisfies Pick<IpcMain, "handle">, {
    trusted: received => { assert.equal(received, event); if (!state.trusted) throw new Error("untrusted"); },
    assertString: (value, _name, max): asserts value is string => { if (typeof value !== "string" || value.length > max) throw new TypeError("invalid id"); },
    platform, overlaySupported,
    showOpenDialog: async options => { calls.push(["dialog", options]); return { canceled: state.canceled, filePaths: state.paths }; },
    removeLayout: key => { calls.push(["layout", key]); },
    registeredGames: {
      snapshot: async () => ({ detection: "available", backgroundDetectionEnabled: false, games: [] }),
      getActivity: async () => ({ enabled: false, game: null }),
      setBackgroundDetectionEnabled: async enabled => { calls.push(["background", enabled]); return true; },
      addExecutable: async path => { calls.push(["add", path]); return game; },
      remove: async id => { calls.push(["remove", id]); return state.removed; },
      setDisplayName: async (id, name) => { calls.push(["name", id, name]); return true; },
      setJoinAdapter: async (id, adapter) => { calls.push(["adapter", id, adapter]); return true; },
      setShareAllowed: async (id, value) => { calls.push(["share", id, value]); return true; },
      setOverlayAllowed: async (id, value) => { calls.push(["overlay", id, value]); return true; },
    },
  });
  return { calls, state, game, handlers, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args) };
}

test("all nine registry commands reject an untrusted sender before native or registry operations", async () => {
  const h = harness(); h.state.trusted = false;
  assert.equal(h.handlers.size, 9);
  for (const channel of h.handlers.keys()) await assert.rejects(async () => h.invoke(channel), /untrusted/);
  assert.deepEqual(h.calls, []);
});

for (const [platform, supported, expected] of [["win32", true, "available"], ["win32", false, "unavailable"], ["linux", true, "unsupported"]] as const) {
  test(`registry snapshot reports ${expected} overlay support`, async () => {
    const result = await harness(platform, supported).invoke("get-registered-games");
    assert.deepEqual(result, { detection: "available", backgroundDetectionEnabled: false, games: [], overlaySupport: expected });
  });
}

test("only a successful game removal clears its stored overlay layout", async () => {
  const h = harness();
  assert.equal(await h.invoke("remove-registered-game", "game"), true);
  assert.deepEqual(h.calls, [["remove", "game"], ["layout", "game:game"]]);
  h.calls.length = 0; h.state.removed = false;
  assert.equal(await h.invoke("remove-registered-game", "missing"), false);
  assert.deepEqual(h.calls, [["remove", "missing"]]);
});

test("native selection keeps executable paths in main and handles cancellation and unsupported platforms", async () => {
  const h = harness();
  assert.equal(await h.invoke("add-registered-game"), h.game);
  assert.deepEqual(h.calls[0], ["dialog", { title: "Select a game executable", properties: ["openFile"], filters: [{ name: "Windows applications", extensions: ["exe"] }] }]);
  assert.deepEqual(h.calls[1], ["add", "C:/fixture/game.exe"]);
  h.calls.length = 0; h.state.canceled = true;
  assert.equal(await h.invoke("add-registered-game"), null);
  assert.equal(h.calls.length, 1);
  h.state.canceled = false; h.state.paths = [];
  assert.equal(await h.invoke("add-registered-game"), null);
  const unsupported = harness("linux");
  assert.equal(await unsupported.invoke("add-registered-game"), null);
  assert.deepEqual(unsupported.calls, []);
});

test("boolean and ID validation precede mutation while adapter validation stays in the registry", async () => {
  const h = harness();
  for (const channel of ["set-registered-game-sharing", "set-registered-game-overlay"]) {
    await assert.rejects(async () => h.invoke(channel, "game", "true"), /boolean/);
    await assert.rejects(async () => h.invoke(channel, "x".repeat(65), true), /invalid id/);
  }
  await assert.rejects(async () => h.invoke("set-registered-games-background-detection", 1), /boolean/);
  assert.deepEqual(h.calls, []);
  assert.equal(await h.invoke("set-registered-games-background-detection", true), true);
  assert.equal(await h.invoke("set-registered-game-sharing", "game", false), true);
  assert.equal(await h.invoke("set-registered-game-overlay", "game", true), true);
  const adapter = { opaque: "registry validates this" };
  assert.equal(await h.invoke("set-registered-game-join-adapter", "game", adapter), true);
  assert.deepEqual(h.calls, [["background", true], ["share", "game", false], ["overlay", "game", true], ["adapter", "game", adapter]]);
});
