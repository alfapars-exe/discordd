import { createStore } from "zustand/vanilla";
import { describe, expect, it } from "vitest";
import { createVoiceWsSlice } from "./voiceWsSlice";
import type { VoiceStore } from "../voiceStore";
import type { VoiceState, VoiceStateUpdateData } from "../../types";

function store() {
  return createStore<VoiceStore>()((...args) => ({
    voiceStates: {}, screenShareViewers: {}, ...createVoiceWsSlice(...args),
  }) as VoiceStore);
}
const person = (patch: Partial<VoiceState> = {}): VoiceState => ({
  user_id: "person", channel_id: "room", server_id: "server", username: "person",
  display_name: "Person", avatar_url: "", is_muted: false, is_deafened: false,
  is_streaming: false, is_server_muted: false, is_server_deafened: false, ...patch,
});
const delta = (action: VoiceStateUpdateData["action"], patch: Partial<VoiceState> = {}): VoiceStateUpdateData => ({ ...person(patch), action });

describe("voice mutation revision reconciliation independent regressions", () => {
  it("accepts a legacy null authoritative viewer set without throwing", () => {
    const s = store();
    s.setState({ screenShareViewers: { person: ["A"] } });
    expect(s.getState().handleScreenShareViewerUpdate({
      streamer_user_id: "person", channel_id: "room", viewer_count: 0,
      viewer_user_id: "A", action: "leave", viewer_user_ids: null,
    }, "process-A", 11)).toBe(true);
    expect(s.getState().screenShareViewers).toEqual({});
  });

  it("retains a full versioned update arriving before the first snapshot", () => {
    const s = store();
    s.getState().setVoiceEpoch("process-A");
    s.getState().handleVoiceStateUpdate(delta("update", { is_muted: true }), "process-A", 11);
    s.getState().handleVoiceStatesSync([person()], "process-A", 10);
    expect(s.getState().voiceStates.room).toEqual([person({ is_muted: true })]);
  });

  it("does not resurrect a leave or roll back a newer snapshot", () => {
    const s = store();
    s.getState().setVoiceEpoch("process-A");
    s.getState().handleVoiceStateUpdate(delta("leave"), "process-A", 12);
    s.getState().handleVoiceStatesSync([person()], "process-A", 10);
    expect(s.getState().voiceStates).toEqual({});
    s.getState().handleVoiceStatesSync([], "process-A", 20);
    s.getState().handleVoiceStatesSync([person()], "process-A", 5);
    expect(s.getState().voiceStates).toEqual({});
    expect(s.getState().handleVoiceStateUpdate(delta("join"), "process-A", 13)).toBe(false);
  });

  it("rejects a retired process snapshot and preserves a fresh pre-sync delta", () => {
    const s = store();
    s.getState().setVoiceEpoch("process-A");
    s.getState().handleVoiceStatesSync([person()], "process-A", 900);
    s.getState().setVoiceEpoch("process-B");
    s.getState().handleVoiceStateUpdate(delta("join", { channel_id: "new-room" }), "process-B", 2);
    s.getState().handleVoiceStatesSync([], "process-B", 1);
    s.getState().handleVoiceStatesSync([person()], "process-A", 901);
    expect(Object.keys(s.getState().voiceStates)).toEqual(["new-room"]);
    expect(s.getState().handleVoiceStateUpdate(delta("leave", { channel_id: "new-room" }), "process-A", 999)).toBe(false);
  });

  it("merges an authoritative viewer set rather than losing pre-snapshot viewers", () => {
    const s = store();
    s.getState().setVoiceEpoch("process-A");
    const viewers = {
      streamer_user_id: "person", channel_id: "room", viewer_count: 2,
      viewer_user_id: "B", action: "join", viewer_user_ids: ["A", "B"],
    };
    s.getState().handleScreenShareViewerUpdate(viewers, "process-A", 11);
    s.getState().handleVoiceStatesSync([person({ is_streaming: true, screen_share_viewers: ["A"] })], "process-A", 10);
    expect(s.getState().screenShareViewers.person?.sort()).toEqual(["A", "B"]);
  });

  it.each(["leave", "update"] as const)("does not retain snapshot viewers after a newer %s stops the stream", (action) => {
    const s = store();
    s.getState().setVoiceEpoch("process-A");
    s.getState().handleVoiceStateUpdate(delta(action, { is_streaming: false }), "process-A", 11);
    s.getState().handleVoiceStatesSync([person({ is_streaming: true, screen_share_viewers: ["A"] })], "process-A", 10);
    expect(s.getState().screenShareViewers).toEqual({});
  });
});
