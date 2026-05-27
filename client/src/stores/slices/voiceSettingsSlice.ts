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

/**
 * Screen-share resolution preset.
 *   - "720p" / "1080p" / "1440p" — fixed targets that any monitor can downscale to.
 *   - "native" — resolves to the active monitor's physical pixel count via
 *     useDisplayInfo at publish time. Hidden from the dropdown on monitors
 *     ≤ 1440p (the existing tier list already covers them) and on web
 *     (Electron-only IPC).
 */
export type ScreenShareQuality = "720p" | "1080p" | "1440p" | "native";

/**
 * Screen-share frame rate.
 *   - 30 / 60 / 120 — fixed targets.
 *   - -1 — sentinel for "use monitor's native refresh rate" (resolved at
 *     publish time from useDisplayInfo.refreshRate). We use a sentinel
 *     number instead of a discriminated union so the existing arithmetic
 *     (`fps === 60 ? ... : ...` in publish defaults) stays type-clean
 *     after a single resolve step at the call site.
 */
export type ScreenShareFps = 30 | 60 | 120 | -1;

/**
 * Noise suppression level — controls the post-RNNoise VAD gate's open/close
 * dB thresholds + hold time. Layered with the existing micSensitivity slider:
 * the level sets a base curve, sensitivity offsets it ±6 dB. sensitivity=100
 * still disables the gate entirely (legacy "off" semantic preserved).
 *
 * Mapping (see gateConfig.LEVEL_BASE):
 *   "low"      — open=-60dB / close=-65dB / hold=400ms (effectively pass-through)
 *   "medium"   — open=-52dB / close=-58dB / hold=300ms (default — passes quiet speech, blocks fan/keyboard)
 *   "high"     — open=-45dB / close=-52dB / hold=200ms (tight, kicks more noise)
 *   "maximum"  — open=-38dB / close=-45dB / hold=150ms (very tight; loud rooms only)
 */
export type NoiseSuppressionLevel = "low" | "medium" | "high" | "maximum";

/**
 * Available noise-reduction engines. See the noiseReductionEngine field
 * docs below for the per-engine pipeline + status notes.
 *
 * NOTE on werman/noise-suppression-for-voice:
 * That popular project is a native VST/LV2/AU plugin (C++), not a
 * browser library — it wraps Xiph's RNNoise for DAW + OS-level audio
 * pipelines (OBS, Equalizer APO, PipeWire). We deliver the SAME
 * underlying RNNoise model via WASM through @sapphi-red/web-noise-
 * suppressor, so there's no functional benefit to adding werman as an
 * "engine" — the model is identical, only the host platform differs.
 *
 * Earlier revisions of this file exposed four extra engines
 * (`deepfilter`, `dtln`, `speex`, `dpdfnet`) as "BETA placeholders"
 * that silently fell back to RNNoise. They've been removed because:
 *  - The UI lied: users picking "DeepFilterNet3" got plain RNNoise.
 *  - The fallback toast disclosed the lie on every selection — a
 *    smell that the option shouldn't have been there at all.
 *  - Wiring those engines for real means adding ~5-10 MB of WASM +
 *    model weights per engine, plus an integration audit. That's its
 *    own project, not a settings dropdown.
 * Picking one of the removed engines from a stale localStorage entry
 * now migrates to "rnnoise" (see loadSettings).
 */
export type NoiseReductionEngine =
  | "rnnoise"
  | "krisp"
  | "webrtc"
  // Beta engines: dropdown selects them, useAudioProcessor recognises
  // them and currently runs the RNNoise fallback while toasting.
  | "deepfilter"
  | "dtln"
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
   * Engine used when noiseReduction is on. Three real options:
   *
   *   Custom-processor pipeline (LiveKit TrackProcessor + AudioWorklet):
   *    - "rnnoise"     — bundled OSS ML denoiser, free, default.
   *                      Uses Xiph's RNNoise via @sapphi-red/web-noise-
   *                      suppressor (the same model that werman's
   *                      native VST/LV2 plugin wraps).
   *    - "krisp"       — LiveKit Cloud's Krisp filter. Paid plan; falls
   *                      back to RNNoise on init failure.
   *
   *   Browser-native pipeline (track constraint):
   *    - "webrtc"      — getUserMedia({ noiseSuppression: true }). No
   *                      AudioWorklet, no WASM, no model file. Works on
   *                      every Chromium/Electron build.
   */
  noiseReductionEngine: NoiseReductionEngine;
  noiseSuppressionLevel: NoiseSuppressionLevel;
  screenShareVolumes: Record<string, number>;
  screenShareAudio: boolean;
  screenShareQuality: ScreenShareQuality;
  screenShareFps: ScreenShareFps;
  /**
   * Whether the mouse cursor is captured into the screen-share stream.
   * true → `getDisplayMedia({ video: { cursor: "always" } })`. Default true
   * matches Discord/Zoom/Teams behaviour and the browser API default.
   * Wired through utils/screenShareCursorPatch.ts which monkey-patches
   * navigator.mediaDevices.getDisplayMedia at boot, so LiveKit's internal
   * setScreenShareEnabled call honours it without touching the SDK API.
   */
  screenShareShowCursor: boolean;
  /**
   * Low-latency screen share mode. When true:
   *   - codec switches VP9 → H264 (hardware-encoded on most platforms,
   *     50-150ms lower encoder latency at the cost of ~30% bandwidth
   *     efficiency).
   *   - encoder degradation pref biases toward maintaining framerate over
   *     resolution (applied at room level — see useScreenSharePublishDefaults).
   *
   * Default false (better quality). Power-user toggle in the screen share
   * options popup. Trade-off documented in user-visible tooltip.
   */
  screenShareLowLatency: boolean;
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

/**
 * Engines that used to appear in the picker but never actually worked
 * (BETA placeholders that always fell back to RNNoise). Any user with
 * one of these in their persisted settings gets quietly migrated to
 * "rnnoise" on load — same audio they were already getting, just with
 * an honest label in Settings → Voice.
 */
const REMOVED_ENGINES = new Set(["deepfilter", "dtln", "speex", "dpdfnet"]);

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
  noiseSuppressionLevel: "medium",
  screenShareVolumes: {},
  // Default true: most users sharing a screen also want to share its audio
  // (gameplay, presentations, video). When the toggle is on, the browser's
  // native picker still shows its own "share audio" checkbox so users who
  // don't want audio can uncheck it at the OS level. A false default here
  // would silently strip audio before the browser even asks.
  screenShareAudio: true,
  screenShareQuality: "720p",
  screenShareFps: 30,
  screenShareShowCursor: true,
  screenShareLowLatency: false,
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
    // JSON.parse can return any shape — array, primitive, null. Guard
    // against non-object payloads before spreading, otherwise a hand-
    // edited localStorage entry like '"corrupted"' would spread the
    // string's index properties over DEFAULT_SETTINGS and pollute the
    // store with garbage.
    const parsedRaw = JSON.parse(raw);
    const parsed: Partial<VoiceSettings> =
      parsedRaw && typeof parsedRaw === "object" && !Array.isArray(parsedRaw)
        ? (parsedRaw as Partial<VoiceSettings>)
        : {};
    const merged: VoiceSettings = { ...DEFAULT_SETTINGS, ...parsed };

    // One-time migration: previous default was false; users had it saved as
    // false from before the default flipped. Override once to true.
    try {
      if (!localStorage.getItem(SCREEN_SHARE_AUDIO_MIGRATION_KEY)) {
        merged.screenShareAudio = true;
        localStorage.setItem(SCREEN_SHARE_AUDIO_MIGRATION_KEY, "1");
      }
    } catch { /* localStorage unavailable */ }

    // Engine cleanup: if the persisted engine is one of the removed BETA
    // placeholders, snap to "rnnoise". Audio behaviour is unchanged
    // (those engines were already falling back to RNNoise at runtime).
    if (REMOVED_ENGINES.has(merged.noiseReductionEngine as string)) {
      merged.noiseReductionEngine = "rnnoise";
    }

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
    noiseSuppressionLevel: s.noiseSuppressionLevel,
    screenShareVolumes: s.screenShareVolumes,
    screenShareAudio: s.screenShareAudio,
    screenShareQuality: s.screenShareQuality,
    screenShareFps: s.screenShareFps,
    screenShareShowCursor: s.screenShareShowCursor,
    screenShareLowLatency: s.screenShareLowLatency,
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
  setScreenShareShowCursor: (enabled: boolean) => void;
  setScreenShareLowLatency: (enabled: boolean) => void;
  setNoiseReduction: (enabled: boolean) => void;
  setNoiseReductionEngine: (engine: NoiseReductionEngine) => void;
  setNoiseSuppressionLevel: (level: NoiseSuppressionLevel) => void;
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
    noiseSuppressionLevel: initial.noiseSuppressionLevel,
    screenShareVolumes: initial.screenShareVolumes,
    screenShareAudio: initial.screenShareAudio,
    screenShareQuality: initial.screenShareQuality,
    screenShareFps: initial.screenShareFps,
    screenShareShowCursor: initial.screenShareShowCursor,
    screenShareLowLatency: initial.screenShareLowLatency,
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

    setScreenShareShowCursor: (enabled) => {
      set({ screenShareShowCursor: enabled });
      saveSettings(currentSettings(get()));
    },

    setScreenShareLowLatency: (enabled) => {
      set({ screenShareLowLatency: enabled });
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

    setNoiseSuppressionLevel: (level) => {
      set({ noiseSuppressionLevel: level });
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
        screenShareShowCursor: merged.screenShareShowCursor,
        localMutedUsers: merged.localMutedUsers,
        noiseReduction: merged.noiseReduction,
        noiseReductionEngine: merged.noiseReductionEngine,
        noiseSuppressionLevel: merged.noiseSuppressionLevel,
        screenShareVolumes: merged.screenShareVolumes,
      });
    },
  };
};
