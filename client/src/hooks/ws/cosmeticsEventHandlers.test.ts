import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WSMessage } from "../../types";

const h = vi.hoisted(() => ({
  me: { id: "me" } as { id: string } | null,
  applyUpdate: vi.fn(),
  loadMine: vi.fn(() => Promise.resolve()),
  loadServer: vi.fn(() => Promise.resolve()),
  resyncAll: vi.fn(),
  mine: null as unknown,
  loadedServers: {} as Record<string, true>,
}));

vi.mock("../../stores/authStore", () => ({
  useAuthStore: { getState: () => ({ user: h.me }) },
}));

vi.mock("../../stores/cosmeticsStore", () => ({
  useCosmeticsStore: {
    getState: () => ({
      applyUpdate: h.applyUpdate,
      loadMine: h.loadMine,
      loadServer: h.loadServer,
      resyncAll: h.resyncAll,
      mine: h.mine,
      loadedServers: h.loadedServers,
    }),
  },
}));

import { MEMBER_JOIN_REFRESH_DEBOUNCE_MS, MINE_REFRESH_DEBOUNCE_MS, handleCosmeticsEvent } from "./cosmeticsEventHandlers";

const frame = (key: string) => ({ item_id: `b_frame_${key}`, format: "svg", animated: true, asset: { v: 1, frame: key } });

function msg(d: unknown, op = "user_cosmetics_update"): WSMessage {
  return { op, d } as unknown as WSMessage;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.applyUpdate.mockClear();
  h.loadMine.mockClear();
  h.loadServer.mockClear();
  h.resyncAll.mockClear();
  h.mine = null;
  h.loadedServers = {};
  h.me = { id: "me" };
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("handleCosmeticsEvent", () => {
  it("ignores other ops", () => {
    expect(handleCosmeticsEvent(msg({}, "member_update"))).toBe(false);
    expect(h.applyUpdate).not.toHaveBeenCalled();
  });

  it("re-validates slots and drops invalid ones", () => {
    expect(
      handleCosmeticsEvent(
        msg({
          user_id: "u1",
          server_id: "s1",
          slots: { avatar_frame: frame("aurora"), nameplate: { item_id: "x", format: "css", animated: false, asset: "evil" } },
          plain: false,
        }),
      ),
    ).toBe(true);
    const ev = h.applyUpdate.mock.calls[0][0];
    expect(ev.user_id).toBe("u1");
    expect(ev.server_id).toBe("s1");
    expect(Object.keys(ev.slots)).toEqual(["avatar_frame"]);
  });

  it("passes plain through with empty slots", () => {
    handleCosmeticsEvent(msg({ user_id: "u1", server_id: "s1", slots: { avatar_frame: frame("aurora") }, plain: true }));
    const ev = h.applyUpdate.mock.calls[0][0];
    expect(ev.plain).toBe(true);
    expect(ev.slots).toEqual({});
  });

  it("maps a missing server_id to the global scope and ignores malformed payloads", () => {
    handleCosmeticsEvent(msg({ user_id: "u1", slots: {}, plain: false }));
    expect(h.applyUpdate.mock.calls[0][0].server_id).toBeNull();
    handleCosmeticsEvent(msg({ user_id: 5, slots: {} }));
    handleCosmeticsEvent(msg({ user_id: "u1", server_id: 7, slots: {} }));
    handleCosmeticsEvent(msg(null));
    expect(h.applyUpdate).toHaveBeenCalledTimes(1);
  });

  it("debounces a refresh of mine for my own updates, only when mine is loaded", () => {
    h.mine = { items: [] };
    handleCosmeticsEvent(msg({ user_id: "me", server_id: "s1", slots: {}, plain: false }));
    handleCosmeticsEvent(msg({ user_id: "me", server_id: "s2", slots: {}, plain: false }));
    handleCosmeticsEvent(msg({ user_id: "me", server_id: null, slots: {}, plain: false }));
    expect(h.loadMine).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MINE_REFRESH_DEBOUNCE_MS);
    expect(h.loadMine).toHaveBeenCalledTimes(1);

    h.mine = null;
    handleCosmeticsEvent(msg({ user_id: "me", server_id: null, slots: {}, plain: false }));
    vi.advanceTimersByTime(MINE_REFRESH_DEBOUNCE_MS);
    expect(h.loadMine).toHaveBeenCalledTimes(1);
  });

  it("does not refresh mine for someone else's update", () => {
    h.mine = { items: [] };
    handleCosmeticsEvent(msg({ user_id: "u2", server_id: null, slots: {}, plain: false }));
    vi.advanceTimersByTime(MINE_REFRESH_DEBOUNCE_MS);
    expect(h.loadMine).not.toHaveBeenCalled();
  });
});

describe("handleCosmeticsEvent — side effects that must not consume the event", () => {
  const join = (serverId: string) => ({ op: "member_join", server_id: serverId, d: {} }) as unknown as WSMessage;

  it("member_join refreshes a loaded server map once (debounced) and returns false", () => {
    h.loadedServers = { s1: true };
    expect(handleCosmeticsEvent(join("s1"))).toBe(false);
    expect(handleCosmeticsEvent(join("s1"))).toBe(false);
    expect(h.loadServer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MEMBER_JOIN_REFRESH_DEBOUNCE_MS);
    expect(h.loadServer).toHaveBeenCalledTimes(1);
    expect(h.loadServer).toHaveBeenCalledWith("s1", { force: true });
  });

  it("member_join ignores a server that is not loaded, and one unloaded before the timer fires", () => {
    expect(handleCosmeticsEvent(join("s9"))).toBe(false);
    h.loadedServers = { s1: true };
    handleCosmeticsEvent(join("s1"));
    h.loadedServers = {}; // logout reset in between
    vi.advanceTimersByTime(MEMBER_JOIN_REFRESH_DEBOUNCE_MS);
    expect(h.loadServer).not.toHaveBeenCalled();
  });

  it("ready resyncs the cache and returns false", () => {
    expect(handleCosmeticsEvent({ op: "ready", d: {} } as unknown as WSMessage)).toBe(false);
    expect(h.resyncAll).toHaveBeenCalledTimes(1);
  });
});
