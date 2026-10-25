import { beforeEach, describe, expect, it } from "vitest";
import { create } from "zustand";
import { createMusicBotSlice } from "./musicBotSlice";
import type { VoiceStore } from "../voiceStore";
import type { MusicBotChannelState } from "../../types/music";

const store = create<VoiceStore>((...args) => createMusicBotSlice(...args) as VoiceStore);
const state: MusicBotChannelState = { channel_id: "a", server_id: "server-a", is_active: true, is_paused: false, queue: [] };
beforeEach(() => store.setState({ musicBotStates: {}, musicBotRevisions: {}, musicBotUpdatedAt: {}, musicBotResetRevision: 0,currentVoiceChannelId:"a",currentVoiceServerId:"server-a" }));

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

it("rejects stale revisions, foreign sessions, protocol downgrade and non-connected state",()=>{
 const current={...state,session_id:"session-a",revision:9};store.getState().setMusicBotState("a",current);
 for(const stale of [{...current,revision:8},{...current,session_id:"session-old",revision:99},state])store.getState().setMusicBotState("a",stale);
 expect(store.getState().musicBotStates.a).toEqual(current);
 store.setState({currentVoiceChannelId:"other"});store.getState().setMusicBotState("a",{...current,revision:10});expect(store.getState().musicBotStates.a.revision).toBe(9);
});
it("permits explicit authoritative HTTP session replacement while rejecting late old-session WS",()=>{store.getState().setMusicBotState("a",{...state,session_id:"old",revision:9});store.getState().setMusicBotState("a",{...state,session_id:"new",revision:0},true);store.getState().setMusicBotState("a",{...state,session_id:"old",revision:99});expect(store.getState().musicBotStates.a.session_id).toBe("new");});
