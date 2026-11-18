import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type StateCreator } from "zustand/vanilla";
import { createVoiceSettingsSlice, flushPendingVoiceSettingsSave, loadSettings, type VoiceSettingsSlice } from "./voiceSettingsSlice";

const { sync } = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("../preferencesStore", () => ({ usePreferencesStore: { getState: () => ({ set: sync }) } }));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("mqvi_voice_settings_v2_screenShareAudio", "1");
  sync.mockClear();
  vi.useFakeTimers();
});
afterEach(() => { flushPendingVoiceSettingsSave(); vi.useRealTimers(); });

for (const [field, setter, min, max] of [
  ["micSensitivity", "setMicSensitivity", 0, 100],
  ["masterVolume", "setMasterVolume", 0, 100],
  ["inputVolume", "setInputVolume", 0, 200],
  ["deepfilterSuppression", "setDeepfilterSuppression", 0, 100],
] as const) {
  describe(field, () => {
    function store() { return createStore<VoiceSettingsSlice>()(createVoiceSettingsSlice as unknown as StateCreator<VoiceSettingsSlice>); }

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("retains the last valid value for non-finite input %s", value => {
      const voice = store();
      const previous = voice.getState()[field];
      voice.getState()[setter](value);
      expect(voice.getState()[field]).toBe(previous);
      expect(sync).not.toHaveBeenCalled();
      flushPendingVoiceSettingsSave();
      expect(loadSettings()[field]).toBe(previous);
    });

    it("clamps finite edits to the same bounds accepted by reload", () => {
      const voice = store();
      for (const [input, expected] of [[min - 1, min], [max + 1, max]]) {
        voice.getState()[setter](input);
        expect(voice.getState()[field]).toBe(expected);
        flushPendingVoiceSettingsSave();
        expect(loadSettings()[field]).toBe(expected);
      }
    });

    it("preserves both valid boundaries through local storage", () => {
      const voice = store();
      for (const value of [min, max]) {
        voice.getState()[setter](value);
        flushPendingVoiceSettingsSave();
        expect(loadSettings()[field]).toBe(value);
      }
    });
  });
}
