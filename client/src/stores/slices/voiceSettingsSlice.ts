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
 * Camera resolution preset. Maps to VideoPresets.h360 / h720 / h1080 in
 * useCameraPublishDefaults, which also derives the simulcast ladder from it.
 * Default "720p": the sweet spot for a webcam tile — noticeably sharper than
 * the SDK's unconfigured default without the upstream cost of 1080p.
 */
export type CameraQuality = "360p" | "720p" | "1080p";

/**
 * Camera frame rate. 30 is the default (natural motion); 15 halves the frame
 * budget and spends the same bitrate ceiling on fewer, sharper frames —
 * useful on weak uplinks or laptop encoders.
 */
export type CameraFps = 15 | 30;

/**
 * Microphone profile — picks the whole capture + publish + processor chain.
 *
 *   - "konusma" (speech, default): mono capture, browser AEC/NS/AGC on, the
 *     RNNoise-family processor attached, Opus DTX + RED on.
 *   - "muzik" (music): stereo capture, all voice DSP off, noise-suppression
 *     processor bypassed, Opus DTX + RED off with forced stereo.
 *
 * The full rationale and the exact option objects live in audio/micProfile.ts.
 * Changing this republishes the mic track (via useMicSync) rather than
 * reconnecting the room.
 */
export type MicProfile = "konusma" | "muzik";

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
 * Available noise-reduction engines.
 *
 * History:
 *  - "dpdfnet" was a label-only impersonation of DeepFilterNet3 (UI lied:
 *    selecting it ran the same engine as "deepfilter"). Removed in v2.11.81;
 *    stale localStorage entries are migrated to "rnnoise" by loadSettings.
 *  - "deepfilter" and "dtln" are now both fully wired to their real
 *    underlying models (DeepFilterNet3 via deepfilternet3-noise-filter,
 *    DTLN via @sapphi-red/dtln-web). No more BETA fallbacks.
 *
 * On werman/noise-suppression-for-voice (not exposed as an engine):
 * That popular project is a native VST/LV2/AU plugin (C++), not a
 * browser library — it wraps Xiph's RNNoise for DAW + OS-level audio.
 * We already deliver the same RNNoise model via WASM through the
 * "rnnoise" engine, so adding werman would be redundant.
 */
export type NoiseReductionEngine =
  | "rnnoise"
  | "krisp"
  | "webrtc"
  | "deepfilter"
  | "dtln"
  | "speex";

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
  /**
   * DeepFilterNet3 suppression strength as a 0-100 % (0 = passthrough,
   * 100 = full suppression). NOT a raw dB value: useAudioProcessor maps it to
   * upstream's attenuation-limit in dB via strengthToAttenLimDb (perceptual
   * mix domain) before df_create / setSuppressionLevel, so the slider is
   * linear in "% denoised". Live-tunable without rebuilding the audio graph.
   * Independent from noiseSuppressionLevel (gate-only mode). Default 70 ≈ 70 %
   * denoised (~10 dB) — a clean-but-natural medium preset.
   */
  deepfilterSuppression: number;
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
  /**
   * Screen-share content profile.
   *   - "motion": video / games / animations. Pairs with maintain-framerate
   *     degradation + contentHint:"motion". Bandwidth tight → resolution
   *     softens first, frame rate stays smooth. (Discord-default behaviour.)
   *   - "detail": presentations / code / docs. Pairs with maintain-resolution
   *     degradation + contentHint:"detail". Bandwidth tight → frame rate
   *     drops first, text stays sharp.
   *
   * Default "motion" because most users share gameplay/video. Power users
   * sharing slides or text should switch to "detail" via Voice Settings.
   * Setting takes effect immediately on the next screen-share start (and
   * mid-stream when the publish opts are passed per-publish — see
   * useScreenShareToggle).
   */
  screenShareMode: ScreenShareMode;
  /**
   * Camera resolution + frame rate. Applied per-publish by
   * useCameraPublishDefaults → setCameraEnabled(enabled, capture, publish).
   * Mid-session changes take effect on the NEXT camera toggle, matching the
   * screen-share semantics (LiveKit doesn't re-encode a live publication).
   */
  cameraQuality: CameraQuality;
  cameraFps: CameraFps;
  /**
   * Microphone profile. "muzik" disables noise suppression entirely — see
   * audio/micProfile.ts. Changing it triggers a mic republish cycle in
   * useMicSync, not a room reconnect.
   */
  micProfile: MicProfile;
  /**
   * Whether the standalone mute-toggle hotkey (see `muteHotkey`) is active.
   * Default false (opt-in) — unlike PTT, this shortcut can fire while the
   * app window is merely focused (or, when `muteHotkeyGlobal` is on,
   * whenever the OS delivers the key at all), so it stays off until a user
   * deliberately enables it in Voice Settings.
   */
  muteHotkeyEnabled: boolean;
  /**
   * KeyboardEvent.code bound to the mute-toggle hotkey. Default "KeyL". If
   * it collides with the active PTT key, PTT wins (see useKeyboardShortcuts
   * guard). Scope (focused-only vs. global) is controlled by
   * `muteHotkeyGlobal`.
   */
  muteHotkey: string;
  /**
   * Electron-only: when true, the mute hotkey is registered as a global
   * uIOhook shortcut (electron/push-to-talk.ts registerMuteHotkey) and
   * fires even while the HiChat window is unfocused. When false (default),
   * the hotkey only fires while the app window is focused, via the
   * document-level listener in useKeyboardShortcuts — the original
   * behavior before this field existed. Has no effect on web; the settings
   * row for it is hidden there.
   *
   * Device-local by design: persisted to localStorage and included in the
   * OUTBOUND preferences sync payload (currentSettings(), for other devices
   * to display read-only), but `applyFromServer()` deliberately ignores it
   * on the way IN (see that function). A synced value would let one device
   * silently arm a system-wide keyboard hook on another — the hook itself
   * only ever compares one keycode (see hotkey-router.ts's privacy note),
   * but "which device is watching every keystroke" must never be decided
   * remotely.
   */
  muteHotkeyGlobal: boolean;
};

/** Display profile that shapes encoder degradation + content hint. */
export type ScreenShareMode = "motion" | "detail";

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
 * Engines removed from the picker over time. Persisted settings with one
 * of these values get quietly migrated to "rnnoise" on load:
 *  - "dpdfnet" (v2.11.81): was an alias for "deepfilter" with a different
 *    label — UI lie, removed alongside DTLN/DeepFilter real-engine wiring.
 */
const REMOVED_ENGINES = new Set<string>(["dpdfnet"]);

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
  deepfilterSuppression: 70,
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
  screenShareMode: "motion",
  cameraQuality: "720p",
  cameraFps: 30,
  micProfile: "konusma",
  muteHotkeyEnabled: false,
  muteHotkey: "KeyL",
  muteHotkeyGlobal: false,
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

function persistNow(settings: VoiceSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage full or inaccessible */
  }
  usePreferencesStore.getState().set({ voice_settings: settings });
}

/**
 * Persistence is debounced: a slider drag fires a setter per pointer move,
 * and each save used to do a synchronous localStorage JSON.stringify of the
 * full settings object PLUS a second store update (preferences sync) — per
 * pixel. A trailing debounce coalesces a whole drag into one write. The
 * in-memory zustand state stays immediate, so live consumers (mic test
 * gain, volume sync) are unaffected.
 */
const SAVE_DEBOUNCE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: VoiceSettings | null = null;

function saveSettings(settings: VoiceSettings): void {
  pendingSave = settings;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const toWrite = pendingSave;
    pendingSave = null;
    if (toWrite) persistNow(toWrite);
  }, SAVE_DEBOUNCE_MS);
}

/** Drop a not-yet-written save — used when server data is authoritative. */
function cancelPendingSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pendingSave = null;
}

/** Write a pending save immediately (page unload — don't lose the last drag). */
export function flushPendingVoiceSettingsSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pendingSave) {
    const toWrite = pendingSave;
    pendingSave = null;
    persistNow(toWrite);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushPendingVoiceSettingsSave);
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
    deepfilterSuppression: s.deepfilterSuppression,
    screenShareVolumes: s.screenShareVolumes,
    screenShareAudio: s.screenShareAudio,
    screenShareQuality: s.screenShareQuality,
    screenShareFps: s.screenShareFps,
    screenShareShowCursor: s.screenShareShowCursor,
    screenShareLowLatency: s.screenShareLowLatency,
    screenShareMode: s.screenShareMode,
    cameraQuality: s.cameraQuality,
    cameraFps: s.cameraFps,
    micProfile: s.micProfile,
    muteHotkeyEnabled: s.muteHotkeyEnabled,
    muteHotkey: s.muteHotkey,
    muteHotkeyGlobal: s.muteHotkeyGlobal,
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
  setScreenShareMode: (mode: ScreenShareMode) => void;
  setCameraQuality: (quality: CameraQuality) => void;
  setCameraFps: (fps: CameraFps) => void;
  setMicProfile: (profile: MicProfile) => void;
  setMuteHotkeyEnabled: (enabled: boolean) => void;
  setMuteHotkey: (key: string) => void;
  setMuteHotkeyGlobal: (enabled: boolean) => void;
  setNoiseReduction: (enabled: boolean) => void;
  setNoiseReductionEngine: (engine: NoiseReductionEngine) => void;
  setNoiseSuppressionLevel: (level: NoiseSuppressionLevel) => void;
  setDeepfilterSuppression: (value: number) => void;
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
    deepfilterSuppression: initial.deepfilterSuppression,
    screenShareVolumes: initial.screenShareVolumes,
    screenShareAudio: initial.screenShareAudio,
    screenShareQuality: initial.screenShareQuality,
    screenShareFps: initial.screenShareFps,
    screenShareShowCursor: initial.screenShareShowCursor,
    screenShareLowLatency: initial.screenShareLowLatency,
    screenShareMode: initial.screenShareMode,
    cameraQuality: initial.cameraQuality,
    cameraFps: initial.cameraFps,
    micProfile: initial.micProfile,
    muteHotkeyEnabled: initial.muteHotkeyEnabled,
    muteHotkey: initial.muteHotkey,
    muteHotkeyGlobal: initial.muteHotkeyGlobal,
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

    setScreenShareMode: (mode: ScreenShareMode) => {
      set({ screenShareMode: mode });
      saveSettings(currentSettings(get()));
    },

    setCameraQuality: (quality: CameraQuality) => {
      set({ cameraQuality: quality });
      saveSettings(currentSettings(get()));
    },

    setCameraFps: (fps: CameraFps) => {
      set({ cameraFps: fps });
      saveSettings(currentSettings(get()));
    },

    setMicProfile: (profile: MicProfile) => {
      set({ micProfile: profile });
      saveSettings(currentSettings(get()));
    },

    setMuteHotkeyEnabled: (enabled) => {
      set({ muteHotkeyEnabled: enabled });
      saveSettings(currentSettings(get()));
    },

    setMuteHotkey: (key) => {
      set({ muteHotkey: key });
      saveSettings(currentSettings(get()));
    },

    setMuteHotkeyGlobal: (enabled) => {
      set({ muteHotkeyGlobal: enabled });
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

    setDeepfilterSuppression: (value) => {
      // Clamp to 0-100 — this is a strength %, mapped to DeepFilterNet3's
      // dB attenuation limit downstream (strengthToAttenLimDb), not raw dB.
      const clamped = Math.max(0, Math.min(100, value));
      set({ deepfilterSuppression: clamped });
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
      // Server payload is authoritative at this moment (login/preferences
      // sync) — a debounced local save racing it would resurrect stale
      // values, so drop it instead of flushing.
      cancelPendingSave();
      const merged: VoiceSettings = { ...DEFAULT_SETTINGS, ...loadSettings() };
      const keys = Object.keys(settings) as (keyof VoiceSettings)[];
      for (const key of keys) {
        // muteHotkeyGlobal is device-local (see its doc comment on
        // VoiceSettings) — skip it here so an inbound sync can neither
        // overwrite the persisted localStorage snapshot below nor the
        // in-memory state further down. currentSettings() still writes it
        // OUTBOUND; only the inbound direction is blocked.
        if (key === "muteHotkeyGlobal") continue;
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
        deepfilterSuppression: merged.deepfilterSuppression,
        screenShareVolumes: merged.screenShareVolumes,
        cameraQuality: merged.cameraQuality,
        cameraFps: merged.cameraFps,
        micProfile: merged.micProfile,
        muteHotkeyEnabled: merged.muteHotkeyEnabled,
        muteHotkey: merged.muteHotkey,
        // muteHotkeyGlobal intentionally omitted — device-local, see the
        // field's doc comment and the `continue` above.
      });
    },
  };
};
