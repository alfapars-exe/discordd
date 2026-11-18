import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStore, type StateCreator } from "zustand/vanilla";
import { cacheable } from "../preferencesCodec";
import { createVoiceSettingsSlice, flushPendingVoiceSettingsSave, loadSettings, type VoiceSettingsSlice } from "./voiceSettingsSlice";

const { sync } = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("../preferencesStore", () => ({ usePreferencesStore: { getState: () => ({ set: sync }) } }));
const invalidIds = ["", "x".repeat(129), "__proto__", "constructor", "prototype"];
function store() { return createStore<VoiceSettingsSlice>()(createVoiceSettingsSlice as unknown as StateCreator<VoiceSettingsSlice>); }
beforeEach(() => { localStorage.clear(); sync.mockClear(); vi.useFakeTimers(); });
afterEach(() => { flushPendingVoiceSettingsSave(); vi.useRealTimers(); });

for (const [field, setter] of [["userVolumes", "setUserVolume"], ["screenShareVolumes", "setScreenShareVolume"]] as const) {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(`${field}: retains a peer's last edited volume for non-finite input %s`, value => {
    const voice = store();
    voice.getState()[setter]("peer", 75); flushPendingVoiceSettingsSave(); sync.mockClear();
    voice.getState()[setter]("peer", value);
    expect(voice.getState()[field]).toEqual({ peer: 75 });
    expect(sync).not.toHaveBeenCalled();
    flushPendingVoiceSettingsSave();
    expect(loadSettings()[field]).toEqual({ peer: 75 });
  });

  it(`${field}: clamps finite edits and preserves unrelated peer values across reload`, () => {
    const voice = store();
    voice.getState()[setter]("other", 140);
    for (const [input, expected] of [[-1, 0], [201, 200]]) {
      voice.getState()[setter]("peer", input); flushPendingVoiceSettingsSave();
      expect(voice.getState()[field]).toEqual({ other: 140, peer: expected });
      expect(loadSettings()[field]).toEqual({ other: 140, peer: expected });
    }
  });

  it.each(invalidIds)(`${field}: ignores invalid peer key %s`, id => {
    const voice = store(); voice.getState()[setter](id, 75);
    expect(voice.getState()[field]).toEqual({});
    expect(sync).not.toHaveBeenCalled();
  });

  it.each(["x".repeat(128), "__music_bot__:channel"])(`${field}: retains supported peer key %s and both boundaries`, id => {
    const voice = store();
    for (const value of [0, 200]) {
      voice.getState()[setter](id, value); flushPendingVoiceSettingsSave();
      expect(loadSettings()[field]).toEqual({ [id]: value });
    }
  });
}

it.each(invalidIds)("ignores invalid local-mute peer key %s", id => {
  const voice = store(); voice.getState().toggleLocalMute(id);
  expect(voice.getState().localMutedUsers).toEqual({});
  expect(voice.getState().userVolumes).toEqual({});
  expect(voice.getState().preMuteVolumes).toEqual({});
  expect(sync).not.toHaveBeenCalled();
});

for (const field of ["userVolumes", "screenShareVolumes", "localMutedUsers"] as const) {
  it.each(invalidIds)(`${field}: omits invalid cache peer key %s`, id => {
    const cached = cacheable({ voice_settings: { [field]: { [id]: field === "localMutedUsers" ? true : 75 } } });
    expect((cached.voice_settings as Record<string, unknown> | undefined)?.[field] ?? {}).toEqual({});
  });
}

it.each(["toString", "hasOwnProperty"])("keeps own mute state and finite restore values for peer %s", id => {
  const voice = store();
  voice.getState().toggleLocalMute(id);
  expect(voice.getState().localMutedUsers).toEqual({ [id]: true });
  expect(voice.getState().userVolumes).toEqual({ [id]: 0 });
  expect(voice.getState().preMuteVolumes).toEqual({ [id]: 100 });
  voice.getState().toggleLocalMute(id);
  expect(voice.getState().localMutedUsers).toEqual({});
  expect(voice.getState().userVolumes).toEqual({ [id]: 100 });
  expect(sync).toHaveBeenLastCalledWith({ voice_settings: { userVolumes: { [id]: 100 }, localMutedUsers: { [id]: false } } });
});
