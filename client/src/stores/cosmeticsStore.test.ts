import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/cosmetics", () => ({
  getMine: vi.fn(),
  equip: vi.fn(),
  setPlainServer: vi.fn(),
  lookupGlobal: vi.fn(),
  getServerCosmetics: vi.fn(),
  cosmeticsErrorKey: () => "errors.generic",
}));

import * as api from "../api/cosmetics";
import { useCosmeticsStore, GLOBAL_TTL_MS, GLOBAL_LOOKUP_DEBOUNCE_MS } from "./cosmeticsStore";
import { EMPTY_SLOTS } from "../utils/cosmetics";
import type { EquippedCosmetic } from "../types/cosmetics";

const mockedApi = vi.mocked(api);

const frame = (key: string): EquippedCosmetic => ({
  item_id: `b_frame_${key}`,
  format: "svg",
  animated: false,
  asset: { v: 1, frame: key },
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCosmeticsStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cosmeticsStore — reset + generation", () => {
  it("ignores a server response that lands after reset()", async () => {
    const d = deferred<Awaited<ReturnType<typeof api.getServerCosmetics>>>();
    mockedApi.getServerCosmetics.mockReturnValueOnce(d.promise);
    const p = useCosmeticsStore.getState().loadServer("s1");
    useCosmeticsStore.getState().reset();
    d.resolve({ success: true, data: { server_id: "s1", users: { u1: { avatar_frame: frame("aurora") } } } });
    await p;
    expect(useCosmeticsStore.getState().loadedServers).toEqual({});
    expect(useCosmeticsStore.getState().byServer).toEqual({});
  });

  it("ignores a stale getMine after reset()", async () => {
    const d = deferred<Awaited<ReturnType<typeof api.getMine>>>();
    mockedApi.getMine.mockReturnValueOnce(d.promise);
    const p = useCosmeticsStore.getState().loadMine();
    useCosmeticsStore.getState().reset();
    d.resolve({
      success: true,
      data: { items: [], grants: [], equipped: { global: {}, servers: {} }, plain_server_ids: [] },
    });
    await p;
    expect(useCosmeticsStore.getState().mine).toBeNull();
  });

  it("de-duplicates in-flight server loads", async () => {
    mockedApi.getServerCosmetics.mockResolvedValue({ success: true, data: { server_id: "s1", users: {} } });
    await Promise.all([
      useCosmeticsStore.getState().loadServer("s1"),
      useCosmeticsStore.getState().loadServer("s1"),
    ]);
    await useCosmeticsStore.getState().loadServer("s1");
    expect(mockedApi.getServerCosmetics).toHaveBeenCalledTimes(1);
    expect(useCosmeticsStore.getState().loadedServers.s1).toBe(true);
  });
});

describe("cosmeticsStore — applyUpdate", () => {
  it("server_id null updates the global map", () => {
    useCosmeticsStore.getState().applyUpdate({ user_id: "u1", server_id: null, slots: { avatar_frame: frame("aurora") }, plain: false });
    expect(useCosmeticsStore.getState().global.u1?.avatar_frame?.item_id).toBe("b_frame_aurora");
  });

  it("is a no-op for a server that was never loaded", () => {
    useCosmeticsStore.getState().applyUpdate({ user_id: "u1", server_id: "s9", slots: { avatar_frame: frame("aurora") }, plain: false });
    expect(useCosmeticsStore.getState().byServer).toEqual({});
  });

  it("plain removes the user from a loaded server map", async () => {
    mockedApi.getServerCosmetics.mockResolvedValue({
      success: true,
      data: { server_id: "s1", users: { u1: { avatar_frame: frame("aurora") } } },
    });
    await useCosmeticsStore.getState().loadServer("s1");
    expect(useCosmeticsStore.getState().byServer.s1.u1).toBeDefined();
    useCosmeticsStore.getState().applyUpdate({ user_id: "u1", server_id: "s1", slots: {}, plain: true });
    expect(useCosmeticsStore.getState().byServer.s1.u1).toBeUndefined();
  });

  it("drops invalid slots on the way in", async () => {
    mockedApi.getServerCosmetics.mockResolvedValue({ success: true, data: { server_id: "s1", users: {} } });
    await useCosmeticsStore.getState().loadServer("s1");
    useCosmeticsStore.getState().applyUpdate({
      user_id: "u1",
      server_id: "s1",
      slots: { avatar_frame: frame("evil") },
      plain: false,
    });
    expect(useCosmeticsStore.getState().byServer.s1.u1).toBeUndefined();
  });

  it("keeps slot references of unchanged users stable", async () => {
    mockedApi.getServerCosmetics.mockResolvedValue({
      success: true,
      data: { server_id: "s1", users: { u1: { avatar_frame: frame("aurora") }, u2: { avatar_frame: frame("frost") } } },
    });
    await useCosmeticsStore.getState().loadServer("s1");
    const u2Before = useCosmeticsStore.getState().byServer.s1.u2;
    const u1Before = useCosmeticsStore.getState().byServer.s1.u1;

    // Same value again → the very same object, no state change.
    useCosmeticsStore.getState().applyUpdate({ user_id: "u1", server_id: "s1", slots: { avatar_frame: frame("aurora") }, plain: false });
    expect(useCosmeticsStore.getState().byServer.s1.u1).toBe(u1Before);

    // A different user changes → u2 keeps its reference.
    useCosmeticsStore.getState().applyUpdate({ user_id: "u1", server_id: "s1", slots: { avatar_frame: frame("ember") }, plain: false });
    expect(useCosmeticsStore.getState().byServer.s1.u1?.avatar_frame?.item_id).toBe("b_frame_ember");
    expect(useCosmeticsStore.getState().byServer.s1.u2).toBe(u2Before);
  });
});

describe("cosmeticsStore — requestGlobal", () => {
  it("debounces, batches ≤100 ids per call and caches empty answers", async () => {
    vi.useFakeTimers();
    mockedApi.lookupGlobal.mockImplementation(async (ids: string[]) => ({
      success: true,
      data: { users: ids.includes("u0") ? { u0: { avatar_frame: frame("aurora") } } : {} },
    }));
    const ids = Array.from({ length: 150 }, (_, i) => `u${i}`);
    useCosmeticsStore.getState().requestGlobal(ids.slice(0, 70));
    useCosmeticsStore.getState().requestGlobal(ids.slice(70));
    expect(mockedApi.lookupGlobal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GLOBAL_LOOKUP_DEBOUNCE_MS);
    expect(mockedApi.lookupGlobal).toHaveBeenCalledTimes(2);
    const sizes = mockedApi.lookupGlobal.mock.calls.map(([batch]) => batch.length).sort((a, b) => a - b);
    expect(sizes).toEqual([50, 100]);

    const state = useCosmeticsStore.getState();
    expect(state.global.u0?.avatar_frame?.item_id).toBe("b_frame_aurora");
    expect(state.global.u1).toBeUndefined();
    expect(state.globalFetchedAt.u1).toBeDefined();

    // Fresh (including negative) entries are not re-requested within the TTL.
    useCosmeticsStore.getState().requestGlobal(["u0", "u1"]);
    await vi.advanceTimersByTimeAsync(GLOBAL_LOOKUP_DEBOUNCE_MS);
    expect(mockedApi.lookupGlobal).toHaveBeenCalledTimes(2);

    // After the TTL they are.
    vi.setSystemTime(Date.now() + GLOBAL_TTL_MS + 1);
    useCosmeticsStore.getState().requestGlobal(["u0", "u1"]);
    await vi.advanceTimersByTimeAsync(GLOBAL_LOOKUP_DEBOUNCE_MS);
    expect(mockedApi.lookupGlobal).toHaveBeenCalledTimes(3);
    expect(mockedApi.lookupGlobal.mock.calls[2][0]).toEqual(["u0", "u1"]);
  });

  it("ignores malformed ids", async () => {
    vi.useFakeTimers();
    useCosmeticsStore.getState().requestGlobal(["../x", ""]);
    await vi.advanceTimersByTimeAsync(GLOBAL_LOOKUP_DEBOUNCE_MS);
    expect(mockedApi.lookupGlobal).not.toHaveBeenCalled();
  });

  it("reset() cancels a pending batch", async () => {
    vi.useFakeTimers();
    useCosmeticsStore.getState().requestGlobal(["u1"]);
    useCosmeticsStore.getState().reset();
    await vi.advanceTimersByTimeAsync(GLOBAL_LOOKUP_DEBOUNCE_MS * 2);
    expect(mockedApi.lookupGlobal).not.toHaveBeenCalled();
    expect(useCosmeticsStore.getState().global).toEqual({});
    expect(EMPTY_SLOTS).toEqual({});
  });
});

describe("cosmeticsStore — equip / plain", () => {
  it("equip folds the server answer into mine", async () => {
    mockedApi.equip.mockResolvedValue({
      success: true,
      data: {
        items: [],
        grants: [],
        equipped: { global: { avatar_frame: frame("laurel") }, servers: {} },
        plain_server_ids: [],
      },
    });
    await useCosmeticsStore.getState().equip({ scope: "global", slots: { avatar_frame: "b_frame_laurel" } });
    expect(useCosmeticsStore.getState().mine?.equipped.global.avatar_frame?.item_id).toBe("b_frame_laurel");
  });

  it("setPlainServer toggles the local plain list", async () => {
    mockedApi.getMine.mockResolvedValue({
      success: true,
      data: { items: [], grants: [], equipped: { global: {}, servers: {} }, plain_server_ids: [] },
    });
    mockedApi.setPlainServer.mockResolvedValue({ success: true, data: undefined, status: 204 });
    await useCosmeticsStore.getState().loadMine();
    await useCosmeticsStore.getState().setPlainServer("s1", true);
    expect(useCosmeticsStore.getState().mine?.plain_server_ids).toEqual(["s1"]);
    await useCosmeticsStore.getState().setPlainServer("s1", false);
    expect(useCosmeticsStore.getState().mine?.plain_server_ids).toEqual([]);
  });
});
