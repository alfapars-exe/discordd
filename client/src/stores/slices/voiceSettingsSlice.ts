/**
 * voiceSettingsSlice — persisted voice settings (input mode, PTT, volumes, devices, etc.)
 *
 * All setters follow the same pattern: update Zustand state, then persist the full
 * current settings snapshot via saveSettings(). The `currentSettings(state)` helper
 * eliminates the repeated 15-field object boilerplate.
 */

import type { StateCreator } from "zustand";
import { usePreferencesStore } from "../preferencesStore";
import type { VoiceStore } from "../voiceStore";

export type InputMode = "voice_activity" | "push_to_talk";
export type ScreenShareQuality = "720p" | "1080p" | "1440p";
export type ScreenShareFps = 30 | 60;

/**
 * Available noise-reduction engines. See the noiseReductionEngine field
 * docs below for the per-engine pipeline + status notes.
 */
export type NoiseReductionEngine =
  | "rnnoise"
  | "krisp"
  | "deepfilter"
  | "dtln"
  | "webrtc"
  | "speex"
  | "dpdfnet";

export type VoiceSettings = {
  inputMode: InputMode;
  pttKey: string;
  micSensitivity: number;
  userVolumes: Record<string, number>;
  inputDevice: string;
  outputDevice: string;
  masterVolume: number;
  inputVolume: number;
  soundsEnabled: boolean;
  localMutedUsers: Record<string, boolean>;
  noiseReduction: boolean;
  /**
   * Engine used when noiseReduction is on. Seven values, two pipelines:
   *
   *   Custom-processor pipeline (LiveKit TrackProcessor + AudioWorklet):
   *    - "rnnoise"     — bundled OSS ML denoiser, free, default.
   *    - "krisp"       — LiveKit Cloud's Krisp filter. Paid plan; falls
   *                      back to RNNoise on init failure.
   *    - "deepfilter"  — DeepFilterNet3 WASM (deepfilter-standalone).
   *                      BETA: currently falls back to RNNoise; full
   *                      WASM integration will land in a follow-up.
   *    - "dtln"        — DTLN web port (@sapphi-red/dtln-web). BETA:
   *                      same fallback contract as deepfilter.
   *    - "speex"       — SpeexDSP via SpeexWorkletNode (classical DSP
   *                      preprocessor; light, no ML model). BETA: real
   *                      WASM integration pending; falls back to RNNoise.
   *    - "dpdfnet"     — DPDFNet (a DeepFilterNet variant). BETA: same
   *                      fallback contract.
   *
   *   Browser-native pipeline (track constraint):
   *    - "webrtc"      — getUserMedia({ noiseSuppression: true }). No
   *                      AudioWorklet, no WASM, no model file. Works on
   *                      every Chromium/Electron build.
   */
  noiseReductionEngine: NoiseReductionEngine;
  screenShareVolumes: Record<string, number>;
  screenShareAudio: boolean;
  screenShareQuality: ScreenShareQuality;
  screenShareFps: ScreenShareFps;
};

const STORAGE_KEY = "mqvi_voice_settings";

/**
 * Migration sentinel for the screenShareAudio default flip (false -> true).
 *
 * The previous default was false, so existing users had `screenShareAudio:
 * false` saved in localStorage. After flipping the default, the merge
 * `{...DEFAULT_SETTINGS, ...parsed}` still gave them false because their
 * stored value wins. That left screen-share audio silently disabled even
 * after the fix shipped.
 *
 * This one-time migration flips their stored value to true and sets this
 * sentinel so we never re-apply. Trade-off: a user who *deliberately*
 * disabled audio sharing before the migration ran will see it re-enabled
 * once. They can toggle it back off and that choice persists.
 */
const SCREEN_SHARE_AUDIO_MIGRATION_KEY = "mqvi_voice_settings_v2_screenShareAudio";

export const DEFAULT_SETTINGS: VoiceSettings = {
  inputMode: "voice_activity",
  pttKey: "Space",
  micSensitivity: 50,
  userVolumes: {},
  inputDevice: "",
  outputDevice: "",
  masterVolume: 100,
  inputVolume: 100,
  soundsEnabled: true,
  localMutedUsers: {},
  noiseReduction: true,
  noiseReductionEngine: "rnnoise",
  screenShareVolumes: {},
  // Default true: most users sharing a screen also want to share its audio
  // (gameplay, presentations, video). When the toggle is on, the browser's
  // native picker still shows its own "share audio" checkbox so users who
  // don't want audio can uncheck it at the OS level. A false default here
  // would silently strip audio before the browser even asks.
  screenShareAudio: true,
  screenShareQuality: "720p",
  screenShareFps: 30,
};

/** Loads voice settings from localStorage with partial merge (new keys get defaults). */
export function loadSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // No saved settings — treat as already migrated; mark to skip on first save.
      try { localStorage.setItem(SCREEN_SHARE_AUDIO_MIGRATION_KEY, "1"); } catch { /* ignore */ }
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    const merged: VoiceSettings = { ...DEFAULT_SETTINGS, ...parsed };

    // One-time migration: previous default was false; users had it saved as
    // false from before the default flipped. Override once to true.
    try {
      if (!localStorage.getItem(SCREEN_SHARE_AUDIO_MIGRATION_KEY)) {
        merged.screenShareAudio = true;
        localStorage.setItem(SCREEN_SHARE_AUDIO_MIGRATION_KEY, "1");
      }
    } catch { /* localStorage unavailable */ }

    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: VoiceSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage full or inaccessible */
  }
  usePreferencesStore.getState().set({ voice_settings: settings });
}

/** Extract settings-shaped subset from the current store state. */
function currentSettings(s: VoiceSettings): VoiceSettings {
  return {
    inputMode: s.inputMode,
    pttKey: s.pttKey,
    micSensitivity: s.micSensitivity,
    userVolumes: s.userVolumes,
    inputDevice: s.inputDevice,
    outputDevice: s.outputDevice,
    masterVolume: s.masterVolume,
    inputVolume: s.inputVolume,
    soundsEnabled: s.soundsEnabled,
    localMutedUsers: s.localMutedUsers,
    noiseReduction: s.noiseReduction,
    noiseReductionEngine: s.noiseReductionEngine,
    screenShareVolumes: s.screenShareVolumes,
    screenShareAudio: s.screenShareAudio,
    screenShareQuality: s.screenShareQuality,
    screenShareFps: s.screenShareFps,
  };
}

export type VoiceSettingsSlice = VoiceSettings & {
  /** Pre-mute volume values for local mute restore */
  preMuteVolumes: Record<string, number>;

  setInputMode: (mode: InputMode) => void;
  setPTTKey: (key: string) => void;
  setMicSensitivity: (value: number) => void;
  setUserVolume: (userId: string, volume: number) => void;
  setScreenShareVolume: (userId: string, volume: number) => void;
  setInputDevice: (deviceId: string) => void;
  setOutputDevice: (deviceId: string) => void;
  setMasterVolume: (value: number) => void;
  setInputVolume: (value: number) => void;
  setSoundsEnabled: (enabled: boolean) => void;
  setScreenShareAudio: (enabled: boolean) => void;
  setScreenShareQuality: (quality: ScreenShareQuality) => void;
  setScreenShareFps: (fps: ScreenShareFps) => void;
  setNoiseReduction: (enabled: boolean) => void;
  setNoiseReductionEngine: (engine: NoiseReductionEngine) => void;
  toggleLocalMute: (userId: string) => void;
  applyFromServer: (settings: Record<string, unknown>) => void;
};

export const createVoiceSettingsSlice: StateCreator<
  VoiceStore,
  [],
  [],
  VoiceSettingsSlice
> = (set, get) => {
  const initial = loadSettings();

  return {
    inputMode: initial.inputMode,
    pttKey: initial.pttKey,
    micSensitivity: initial.micSensitivity,
    userVolumes: initial.userVolumes,
    inputDevice: initial.inputDevice,
    outputDevice: initial.outputDevice,
    masterVolume: initial.masterVolume,
    inputVolume: initial.inputVolume,
    soundsEnabled: initial.soundsEnabled,
    localMutedUsers: initial.localMutedUsers,
    noiseReduction: initial.noiseReduction,
    noiseReductionEngine: initial.noiseReductionEngine,
    screenShareVolumes: initial.screenShareVolumes,
    screenShareAudio: initial.screenShareAudio,
    screenShareQuality: initial.screenShareQuality,
    screenShareFps: initial.screenShareFps,
    preMuteVolumes: {},

    setInputMode: (mode) => {
      set({ inputMode: mode });
      saveSettings(currentSettings(get()));
    },

    setPTTKey: (key) => {
      set({ pttKey: key });
      saveSettings(currentSettings(get()));
    },

    setMicSensitivity: (value) => {
      set({ micSensitivity: value });
      saveSettings(currentSettings(get()));
    },

    setUserVolume: (userId, volume) => {
      set({ userVolumes: { ...get().userVolumes, [userId]: volume } });
      saveSettings(currentSettings(get()));
    },

    setScreenShareVolume: (userId, volume) => {
      set({ screenShareVolumes: { ...get().screenShareVolumes, [userId]: volume } });
      saveSettings(currentSettings(get()));
    },

    setInputDevice: (deviceId) => {
      set({ inputDevice: deviceId });
      saveSettings(currentSettings(get()));
    },

    setOutputDevice: (deviceId) => {
      set({ outputDevice: deviceId });
      saveSettings(currentSettings(get()));
    },

    setMasterVolume: (value) => {
      set({ masterVolume: value });
      saveSettings(currentSettings(get()));
    },

    setInputVolume: (value) => {
      set({ inputVolume: value });
      saveSettings(currentSettings(get()));
    },

    setSoundsEnabled: (enabled) => {
      set({ soundsEnabled: enabled });
      saveSettings(currentSettings(get()));
    },

    setScreenShareAudio: (enabled) => {
      set({ screenShareAudio: enabled });
      saveSettings(currentSettings(get()));
    },

    setScreenShareQuality: (quality) => {
      set({ screenShareQuality: quality });
      saveSettings(currentSettings(get()));
    },

    setScreenShareFps: (fps) => {
      set({ screenShareFps: fps });
      saveSettings(currentSettings(get()));
    },

    setNoiseReduction: (enabled) => {
      set({ noiseReduction: enabled });
      saveSettings(currentSettings(get()));
    },

    setNoiseReductionEngine: (engine) => {
      set({ noiseReductionEngine: engine });
      saveSettings(currentSettings(get()));
    },

    toggleLocalMute: (userId: string) => {
      const { localMutedUsers, preMuteVolumes, userVolumes } = get();
      const isCurrentlyMuted = localMutedUsers[userId] ?? false;

      if (isCurrentlyMuted) {
        const restoredVolume = preMuteVolumes[userId] ?? 100;
        const newLocalMuted = { ...localMutedUsers };
        delete newLocalMuted[userId];
        const newPreMute = { ...preMuteVolumes };
        delete newPreMute[userId];
        const newVolumes = { ...userVolumes, [userId]: restoredVolume };

        set({
          localMutedUsers: newLocalMuted,
          preMuteVolumes: newPreMute,
          userVolumes: newVolumes,
        });
      } else {
        const currentVolume = userVolumes[userId] ?? 100;
        const newLocalMuted = { ...localMutedUsers, [userId]: true };
        const newPreMute = { ...preMuteVolumes, [userId]: currentVolume };
        const newVolumes = { ...userVolumes, [userId]: 0 };

        set({
          localMutedUsers: newLocalMuted,
          preMuteVolumes: newPreMute,
          userVolumes: newVolumes,
        });
      }

      saveSettings(currentSettings(get()));
    },

    applyFromServer: (settings) => {
      const merged: VoiceSettings = { ...DEFAULT_SETTINGS, ...loadSettings() };
      const keys = Object.keys(settings) as (keyof VoiceSettings)[];
      for (const key of keys) {
        if (key in merged) {
          (merged as Record<string, unknown>)[key] = settings[key];
        }
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {
        /* ignore */
      }
      set({
        inputMode: merged.inputMode,
        pttKey: merged.pttKey,
        micSensitivity: merged.micSensitivity,
        userVolumes: merged.userVolumes,
        inputDevice: merged.inputDevice,
        outputDevice: merged.outputDevice,
        masterVolume: merged.masterVolume,
        inputVolume: merged.inputVolume,
        soundsEnabled: merged.soundsEnabled,
        screenShareAudio: merged.screenShareAudio,
        screenShareQuality: merged.screenShareQuality,
        screenShareFps: merged.screenShareFps,
        localMutedUsers: merged.localMutedUsers,
        noiseReduction: merged.noiseReduction,
        noiseReductionEngine: merged.noiseReductionEngine,
        screenShareVolumes: merged.screenShareVolumes,
      });
    },
  };
};
