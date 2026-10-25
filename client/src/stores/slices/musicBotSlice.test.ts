import { beforeEach, describe, expect, it } from "vitest";
import { create } from "zustand";
import { createMusicBotSlice } from "./musicBotSlice";
import type { VoiceStore } from "../voiceStore";
import type { MusicBotChannelState } from "../../types/music";

const store = create<VoiceStore>((...args) => createMusicBotSlice(...args) as VoiceStore);
const state: MusicBotChannelState = { channel_id: "a", server_id: "server-a", is_active: true, is_paused: false, queue: [] };
beforeEach(() => store.setState({ musicBotStates: {}, musicBotRevisions: {}, musicBotUpdatedAt: {}, musicBotResetRevision: 0 }));

describe("music state ownership", () => {
  it("rejects wrong channel or missing server payloads", () => {
    store.getState().setMusicBotState("b", state);
    store.getState().setMusicBotState("a", { ...state, server_id: "" });
    expect(store.getState().musicBotStates).toEqual({});
  });
  it("normalizes a nil queue and records the snapshot revision/time", () => {
    store.getState().setMusicBotState("a", { ...state, queue: null } as unknown as MusicBotChannelState);
    expect(store.getState().musicBotStates.a.queue).toEqual([]);
    expect(store.getState().musicBotRevisions.a).toBe(1);
    expect(store.getState().musicBotUpdatedAt.a).toBeGreaterThan(0);
  });
  it("invalidates outstanding snapshots on both clear and full reset", () => {
    store.getState().setMusicBotState("a", state);
    store.getState().clearMusicBotState("a");
    expect(store.getState().musicBotRevisions.a).toBe(2);
    expect(store.getState().musicBotStates.a).toBeUndefined();
    store.getState().resetMusicBotStates();
    expect(store.getState().musicBotRevisions.a).toBe(3);
    expect(store.getState().musicBotResetRevision).toBe(1);
  });
});
