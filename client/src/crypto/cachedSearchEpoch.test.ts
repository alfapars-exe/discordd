import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  scope: { ownerId: "owner" as string | null, generation: 1 },
  getDB: vi.fn(), name: vi.fn(),
}));
vi.mock("./keyDatabase", () => ({ getDB: state.getDB, getAccountDatabaseName: state.name }));
vi.mock("../api/authSessionEvents", () => ({ getAuthSessionSnapshot: () => ({ ...state.scope }) }));
let receive: ((event: { data: unknown }) => void) | undefined;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  state.scope = { ownerId: "owner", generation: 1 };
  state.name.mockResolvedValue("own-db");
  state.getDB.mockResolvedValue({ name: "own-db", get: vi.fn().mockResolvedValue("epoch") });
  receive = undefined;
  vi.stubGlobal("BroadcastChannel", class {
    set onmessage(callback: typeof receive) { receive = callback; }
    postMessage() {}
  });
});
afterEach(() => vi.unstubAllGlobals());
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it("ignores another account's reset before opening the active account database", async () => {
  await import("./cachedSearchEpoch");
  expect(receive).toBeTypeOf("function");
  receive!({ data: { sourceName: "foreign-db" } });
  await settle();
  expect(state.getDB).not.toHaveBeenCalled();
});

it("ignores reset notifications while signed out", async () => {
  state.scope.ownerId = null;
  await import("./cachedSearchEpoch");
  receive!({ data: { sourceName: "own-db" } });
  await settle();
  expect(state.getDB).not.toHaveBeenCalled();
  expect(state.name).not.toHaveBeenCalled();
});

it.each([null, {}, { sourceName: 1 }, { sourceName: "x".repeat(257) }])("ignores malformed reset data %j", async data => {
  await import("./cachedSearchEpoch");
  receive!({ data }); await settle();
  expect(state.name).not.toHaveBeenCalled();
  expect(state.getDB).not.toHaveBeenCalled();
});

it("observes a failed namespace derivation without opening storage", async () => {
  state.name.mockRejectedValueOnce(new Error("backend unavailable"));
  await import("./cachedSearchEpoch");
  receive!({ data: { sourceName: "own-db" } }); await settle();
  expect(state.getDB).not.toHaveBeenCalled();
});

it("fences session replacement while deriving the notification namespace", async () => {
  let finish!: (name: string) => void;
  state.name.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await import("./cachedSearchEpoch");
  receive!({ data: { sourceName: "own-db" } });
  await settle();
  expect(state.name).toHaveBeenCalled();
  state.scope.generation++;
  finish("own-db"); await settle();
  expect(state.getDB).not.toHaveBeenCalled();
});

it("observes a matching reset through the persistent epoch", async () => {
  const epoch = await import("./cachedSearchEpoch");
  await epoch.getCachedSearchEpoch();
  state.getDB.mockResolvedValue({ name: "own-db", get: vi.fn().mockResolvedValue("new-epoch") });
  const changed = vi.fn();
  const stop = epoch.subscribeCachedSearchResets(changed);
  try {
    receive!({ data: { sourceName: "own-db" } });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(epoch.getCachedSearchResetGeneration()).toBe(1);
  } finally { stop(); }
});
