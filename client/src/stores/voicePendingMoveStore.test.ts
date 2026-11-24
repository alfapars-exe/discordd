import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PENDING_VOICE_MOVE_TTL_MS,
  addPendingVoiceMove,
  clearPendingVoiceMove,
  deriveSidebarVoiceStates,
  expirePendingVoiceMoves,
  ownPendingVoiceRow,
  useVoicePendingMoveStore,
  type PendingVoiceMove,
  type SidebarVoiceSelf,
} from "./voicePendingMoveStore";
import { createVoiceWsSlice } from "./slices/voiceWsSlice";
import type { VoiceStore } from "./voiceStore";
import type { VoiceState, VoiceStateUpdateData } from "../types";

const person = (id: string, channelId: string, patch: Partial<VoiceState> = {}): VoiceState => ({
  user_id: id, channel_id: channelId, server_id: "server", username: id,
  display_name: id.toUpperCase(), avatar_url: `/${id}.png`, is_muted: false, is_deafened: false,
  is_streaming: false, is_server_muted: false, is_server_deafened: false, ...patch,
});
const move = (patch: Partial<PendingVoiceMove> = {}): PendingVoiceMove => ({
  userId: "ada", fromChannelId: "a", toChannelId: "b", startedAt: 1000, ...patch,
});
const self = (patch: Partial<SidebarVoiceSelf> = {}): SidebarVoiceSelf => ({
  user: { id: "me", username: "me", display_name: "Me", avatar_url: "/me.png" },
  pendingVoiceChannelId: null, currentVoiceChannelId: null, recoveryPhase: "idle",
  isMuted: false, isDeafened: false, isServerMuted: false, isServerDeafened: false, ...patch,
});
const idle = self({ user: null });

beforeEach(() => { useVoicePendingMoveStore.setState({ moves: {} }); });
afterEach(() => { vi.useRealTimers(); });

describe("pending voice move helpers", () => {
  it("adds, replaces and clears a move without mutating the input", () => {
    const empty = {};
    const one = addPendingVoiceMove(empty, move());
    expect(empty).toEqual({});
    expect(one).toEqual({ ada: move() });
    expect(addPendingVoiceMove(one, move({ toChannelId: "c", startedAt: 2000 })).ada.toChannelId).toBe("c");
    expect(clearPendingVoiceMove(one, "ada")).toEqual({});
    expect(one).toEqual({ ada: move() });
    expect(clearPendingVoiceMove(one, "nobody")).toBe(one);
  });

  it("expires only the moves older than the rollback window", () => {
    const moves = { ada: move({ startedAt: 1000 }), bob: move({ userId: "bob", startedAt: 3000 }) };
    expect(expirePendingVoiceMoves(moves, 1000 + PENDING_VOICE_MOVE_TTL_MS - 1)).toBe(moves);
    expect(expirePendingVoiceMoves(moves, 1000 + PENDING_VOICE_MOVE_TTL_MS)).toEqual({ bob: moves.bob });
    expect(expirePendingVoiceMoves(moves, 3000 + PENDING_VOICE_MOVE_TTL_MS)).toEqual({});
  });
});

describe("deriveSidebarVoiceStates", () => {
  it("returns the authoritative map untouched when nothing is pending", () => {
    const voiceStates = { a: [person("ada", "a")] };
    const view = deriveSidebarVoiceStates(voiceStates, {}, idle);
    expect(view.byChannel).toBe(voiceStates);
    expect(view.pendingUserIds.size).toBe(0);
  });

  it("shows a moved member under the target channel only, marked pending", () => {
    const voiceStates = { a: [person("ada", "a", { is_muted: true }), person("bob", "a")], b: [person("cy", "b")] };
    const snapshot = structuredClone(voiceStates);
    const view = deriveSidebarVoiceStates(voiceStates, { ada: move() }, idle);
    expect(view.byChannel.a).toEqual([person("bob", "a")]);
    expect(view.byChannel.b).toEqual([person("cy", "b"), person("ada", "b", { is_muted: true })]);
    expect([...view.pendingUserIds]).toEqual(["ada"]);
    // The authoritative state is never written.
    expect(voiceStates).toEqual(snapshot);
  });

  it("shows a move into an empty channel and leaves the emptied source without rows", () => {
    const view = deriveSidebarVoiceStates({ a: [person("ada", "a")] }, { ada: move() }, idle);
    expect(view.byChannel.a).toEqual([]);
    expect(view.byChannel.b).toEqual([person("ada", "b")]);
  });

  it("ignores a move whose member the server no longer lists in the source channel", () => {
    const voiceStates = { b: [person("ada", "b")] };
    const view = deriveSidebarVoiceStates(voiceStates, { ada: move() }, idle);
    expect(view.byChannel).toBe(voiceStates);
    expect(view.pendingUserIds.size).toBe(0);
  });
});

describe("own pending row", () => {
  it("appears in the channel being joined before any token or broadcast", () => {
    const row = ownPendingVoiceRow({}, self({ pendingVoiceChannelId: "b", isMuted: true, isServerDeafened: true }));
    expect(row).toEqual({
      user_id: "me", channel_id: "b", username: "me", display_name: "Me", avatar_url: "/me.png",
      is_muted: true, is_deafened: false, is_streaming: false, is_server_muted: false, is_server_deafened: true,
    });
  });

  it("stays while joined locally until the server lists the user", () => {
    const joined = self({ currentVoiceChannelId: "b", isDeafened: true });
    expect(ownPendingVoiceRow({ b: [person("cy", "b")] }, joined)?.is_deafened).toBe(true);
    expect(ownPendingVoiceRow({ b: [person("cy", "b"), person("me", "b")] }, joined)).toBeNull();
  });

  it("is absent when signed out or not in voice", () => {
    expect(ownPendingVoiceRow({}, self())).toBeNull();
    expect(ownPendingVoiceRow({}, self({ user: null, pendingVoiceChannelId: "b" }))).toBeNull();
  });

  it("falls back to empty strings for a missing display name and avatar", () => {
    const row = ownPendingVoiceRow({}, self({
      user: { id: "me", username: "me", display_name: null, avatar_url: null }, pendingVoiceChannelId: "b",
    }));
    expect(row).toMatchObject({ display_name: "", avatar_url: "" });
  });

  it("is drawn once: pending in the target, hidden from a channel the server still lists", () => {
    const voiceStates = { a: [person("me", "a"), person("bob", "a")] };
    const view = deriveSidebarVoiceStates(voiceStates, {}, self({ pendingVoiceChannelId: "b" }));
    expect(view.byChannel.a).toEqual([person("bob", "a")]);
    expect(view.byChannel.b.map((state) => state.user_id)).toEqual(["me"]);
    expect([...view.pendingUserIds]).toEqual(["me"]);
    expect(voiceStates.a).toHaveLength(2);
  });

  it("gives way to the server entry once it arrives", () => {
    const voiceStates = { b: [person("me", "b", { is_muted: true })] };
    const view = deriveSidebarVoiceStates(voiceStates, {}, self({ currentVoiceChannelId: "b" }));
    expect(view.byChannel).toBe(voiceStates);
    expect(view.pendingUserIds.has("me")).toBe(false);
  });

  // The session was evicted because another session of the account joined
  // channel b, and its recovery ended for good. `currentVoiceChannelId` is
  // still a until the user dismisses the failure, but the row the server
  // lists — under b — is the one to show.
  it("is not drawn for a session whose recovery has failed: the server's rows are shown", () => {
    const failed = self({ currentVoiceChannelId: "a", recoveryPhase: "failed" });
    const voiceStates = { b: [person("me", "b"), person("cy", "b")] };
    const view = deriveSidebarVoiceStates(voiceStates, {}, failed);
    expect(view.byChannel).toBe(voiceStates);
    expect(view.pendingUserIds.size).toBe(0);
    // Listed nowhere: no row at all, instead of one that never confirms.
    expect(ownPendingVoiceRow({}, failed)).toBeNull();
    const elsewhere = { c: [person("cy", "c")] };
    expect(deriveSidebarVoiceStates(elsewhere, {}, failed).byChannel).toBe(elsewhere);
  });

  it("is drawn again for a join started from the failed state", () => {
    const rejoining = self({ currentVoiceChannelId: null, pendingVoiceChannelId: "c", recoveryPhase: "failed" });
    const view = deriveSidebarVoiceStates({ b: [person("me", "b")] }, {}, rejoining);
    expect(view.byChannel.b).toEqual([]);
    expect(view.byChannel.c.map((state) => state.user_id)).toEqual(["me"]);
    expect([...view.pendingUserIds]).toEqual(["me"]);
  });

  it.each(["waiting", "offline", "connecting"] as const)("stays while the recovery is still %s", (recoveryPhase) => {
    const recovering = self({ currentVoiceChannelId: "a", recoveryPhase });
    expect(ownPendingVoiceRow({ b: [person("cy", "b")] }, recovering)?.channel_id).toBe("a");
  });
});

describe("pending voice move store", () => {
  it("records a move and rolls it back after five seconds without confirmation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    useVoicePendingMoveStore.getState().recordMove("ada", "a", "b");
    expect(useVoicePendingMoveStore.getState().moves).toEqual({
      ada: { userId: "ada", fromChannelId: "a", toChannelId: "b", startedAt: 10_000 },
    });
    vi.advanceTimersByTime(PENDING_VOICE_MOVE_TTL_MS - 1);
    expect(useVoicePendingMoveStore.getState().moves.ada).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(useVoicePendingMoveStore.getState().moves).toEqual({});
  });

  it("keeps a newer move of the same member when the older rollback fires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    useVoicePendingMoveStore.getState().recordMove("ada", "a", "b");
    vi.advanceTimersByTime(3000);
    useVoicePendingMoveStore.getState().recordMove("ada", "a", "c");
    vi.advanceTimersByTime(2000);
    expect(useVoicePendingMoveStore.getState().moves.ada?.toChannelId).toBe("c");
    vi.advanceTimersByTime(3000);
    expect(useVoicePendingMoveStore.getState().moves).toEqual({});
  });
});

describe("authoritative voice state clears the overlay", () => {
  const wsStore = () => createStore<VoiceStore>()((...args) => ({
    voiceStates: {}, screenShareViewers: {}, ...createVoiceWsSlice(...args),
  }) as VoiceStore);
  const delta = (action: VoiceStateUpdateData["action"], state: VoiceState): VoiceStateUpdateData => ({ ...state, action });
  const record = () => {
    useVoicePendingMoveStore.getState().recordMove("ada", "a", "b");
    useVoicePendingMoveStore.getState().recordMove("bob", "a", "b");
  };

  it("drops only the updated member's move on a voice_state_update", () => {
    const voice = wsStore();
    record();
    expect(voice.getState().handleVoiceStateUpdate(delta("join", person("ada", "b")))).toBe(true);
    expect(Object.keys(useVoicePendingMoveStore.getState().moves)).toEqual(["bob"]);
  });

  it("keeps the move when the update is rejected as stale", () => {
    const voice = wsStore();
    voice.getState().handleVoiceStatesSync([person("ada", "a")], "epoch", 20);
    record();
    expect(voice.getState().handleVoiceStateUpdate(delta("join", person("ada", "b")), "epoch", 5)).toBe(false);
    expect(Object.keys(useVoicePendingMoveStore.getState().moves)).toEqual(["ada", "bob"]);
  });

  it("drops every move on a voice_states_sync", () => {
    const voice = wsStore();
    record();
    expect(voice.getState().handleVoiceStatesSync([person("ada", "b")])).toBe(true);
    expect(useVoicePendingMoveStore.getState().moves).toEqual({});
  });
});
