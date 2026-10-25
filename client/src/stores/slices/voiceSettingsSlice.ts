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
export type VoiceOverlayPosition = "top-left" | "bottom-left" | "top-right" | "bottom-right";

/**
 * Microphone profile — picks the whole capture + publish + processor chain.
 *
 *   - "konusma" (speech, default): mono capture, browser AEC/AGC on,
 *     browser NS only for the WebRTC engine, Opus DTX + RED on.
 *   - "muzik" (music): stereo capture, all voice DSP off, noise-suppression
 *     processor bypassed, Opus DTX + RED off with forced stereo.
 *
 * The full rationale and the exact option objects live in audio/micProfile.ts.
 * Changing this republishes the mic track (via useMicSync) rather than
 * reconnecting the room.
 */
export type MicProfile = "konusma" | "muzik";

/**
 * Noise suppression level — controls the post-denoiser energy gate's open/close
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
 *  - "krisp" remains in the compatibility type, but is hidden from the picker;
 *    old local and account preferences are migrated to the free "rnnoise" default.
 *  - "gtcrn" uses a 16 kHz model with a 48 kHz host-rate adapter.
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
  | "gtcrn"
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
   * Selected noise-reduction engine. Free choices: RNNoise (48 kHz default),
   * DeepFilterNet3 (48 kHz), GTCRN and DTLN (16 kHz models), SpeexDSP,
   * and browser-native WebRTC. The shared microphone pipeline reports the
   * actual engine separately when a fallback is needed.
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
  /** Hardware IDs are local to this browser/device and never synced to the server. */
  cameraDevice: string;
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
   * Device-local by design: persisted only to localStorage and excluded from
   * both inbound and outbound account preferences. A synced value would let one device
   * silently arm a system-wide keyboard hook on another — the hook itself
   * only ever compares one keycode (see hotkey-router.ts's privacy note),
   * but "which device is watching every keystroke" must never be decided
   * remotely.
   */
  muteHotkeyGlobal: boolean;
  voiceOverlayEnabled: boolean;
  voiceOverlayMode: "desktop" | "game";
  voiceOverlaySpeakingOpacity: number;
  voiceOverlayIdleOpacity: number;
  voiceOverlayScale: number;
  voiceOverlayPosition: VoiceOverlayPosition;
  /** Device-local movement lock; topmost behavior is independent of pinning. */
  voiceOverlayPinned: boolean;
  /** Device-local opt-in to show native widget quick-action controls. */
  voiceOverlayQuickActions: boolean;
  /** Device-local opt-in for mute/deafen button input while widget is click-through locked. */
  voiceOverlayClickableActions: boolean;
  voiceOverlayCompatibility: boolean;
  /** Device-local display of activity already shared by friends. */
  voiceOverlayActivity: boolean;
  voiceOverlayVideo: boolean;
  voiceOverlayStreams: boolean;
  voiceOverlayWelcome: boolean;
  voiceOverlayGoLive: boolean;
  voiceOverlayGameActivityNotifications: boolean;
  voiceOverlayNowPlayingNotifications: boolean;
  /** Device-local opt-in to show read-only genuine unread notification indicators. */
  voiceOverlayNotifications: boolean;
  /** Device-local opt-in to open the main app from the overlay notification panel. */
  voiceOverlayNotificationActions: boolean;
  /** Device-local opt-in to show a short read-only chat excerpt in the overlay. */
  voiceOverlayChat: boolean;
  /** Separate device-local opt-in to open the current chat in the main app. */
  voiceOverlayChatActions: boolean;
  /** Device-local opt-in to compose a message from the dedicated overlay surface. */
  voiceOverlayChatCompose: boolean;
  voiceOverlaySpeakingOnly: boolean;
  /** Device-local presentation preferences for the desktop voice widget. */
  voiceOverlayAvatarSize: "small" | "large";
  voiceOverlayNameDisplay: "always" | "speaking" | "never";
  voiceOverlayMaxParticipants: number;
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
 *  - "krisp": paid integration retained internally, removed from the picker.
 */
const REMOVED_ENGINES = new Set<string>(["dpdfnet", "krisp"]);

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
  cameraDevice: "",
  micProfile: "konusma",
  muteHotkeyEnabled: false,
  muteHotkey: "KeyL",
  muteHotkeyGlobal: false,
  voiceOverlayEnabled: true,
  voiceOverlayMode: "desktop",
  voiceOverlaySpeakingOpacity: 100,
  voiceOverlayIdleOpacity: 35,
  voiceOverlayScale: 100,
  voiceOverlayPosition: "bottom-left",
  voiceOverlayPinned: false,
  voiceOverlayQuickActions: false,
  voiceOverlayClickableActions: false,
  voiceOverlayCompatibility: false,
  voiceOverlayActivity: false,
  voiceOverlayVideo: false,
  voiceOverlayStreams: false,
  voiceOverlayWelcome: false,
  voiceOverlayGoLive: false,
  voiceOverlayGameActivityNotifications: false,
  voiceOverlayNowPlayingNotifications: false,
  voiceOverlayNotifications: false,
  voiceOverlayNotificationActions: false,
  voiceOverlayChat: false,
  voiceOverlayChatActions: false,
  voiceOverlayChatCompose: false,
  voiceOverlaySpeakingOnly: false,
  voiceOverlayAvatarSize: "small",
  voiceOverlayNameDisplay: "always",
  voiceOverlayMaxParticipants: 25,
};

function boundedOverlayNumber(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function validOverlayPosition(value: unknown): value is VoiceOverlayPosition {
  return value === "top-left" || value === "top-right" || value === "bottom-left" || value === "bottom-right";
}

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
    if (typeof merged.cameraDevice !== "string") merged.cameraDevice = "";
    if (typeof merged.voiceOverlayEnabled !== "boolean") merged.voiceOverlayEnabled = false;
    if (merged.voiceOverlayMode !== "desktop" && merged.voiceOverlayMode !== "game") {
      merged.voiceOverlayMode = DEFAULT_SETTINGS.voiceOverlayMode;
    }
    if (typeof merged.voiceOverlaySpeakingOnly !== "boolean") merged.voiceOverlaySpeakingOnly = false;
    if (typeof merged.voiceOverlayPinned !== "boolean") merged.voiceOverlayPinned = DEFAULT_SETTINGS.voiceOverlayPinned;
    if (typeof merged.voiceOverlayQuickActions !== "boolean") merged.voiceOverlayQuickActions = DEFAULT_SETTINGS.voiceOverlayQuickActions;
    if (typeof merged.voiceOverlayClickableActions !== "boolean") merged.voiceOverlayClickableActions = DEFAULT_SETTINGS.voiceOverlayClickableActions;
    if (typeof merged.voiceOverlayCompatibility !== "boolean") merged.voiceOverlayCompatibility = DEFAULT_SETTINGS.voiceOverlayCompatibility;
    if (typeof merged.voiceOverlayGoLive !== "boolean") merged.voiceOverlayGoLive = DEFAULT_SETTINGS.voiceOverlayGoLive;
    if (typeof merged.voiceOverlayGameActivityNotifications !== "boolean") merged.voiceOverlayGameActivityNotifications = false;
    if (typeof merged.voiceOverlayNowPlayingNotifications !== "boolean") merged.voiceOverlayNowPlayingNotifications = false;
    if (typeof merged.voiceOverlayWelcome !== "boolean") merged.voiceOverlayWelcome = DEFAULT_SETTINGS.voiceOverlayWelcome;
    if (typeof merged.voiceOverlayVideo !== "boolean") merged.voiceOverlayVideo = DEFAULT_SETTINGS.voiceOverlayVideo;
    if (typeof merged.voiceOverlayStreams !== "boolean") merged.voiceOverlayStreams = DEFAULT_SETTINGS.voiceOverlayStreams;
    if (typeof merged.voiceOverlayActivity !== "boolean") merged.voiceOverlayActivity = DEFAULT_SETTINGS.voiceOverlayActivity;
    if (typeof merged.voiceOverlayNotifications !== "boolean") merged.voiceOverlayNotifications = DEFAULT_SETTINGS.voiceOverlayNotifications;
    if (typeof merged.voiceOverlayNotificationActions !== "boolean") merged.voiceOverlayNotificationActions = DEFAULT_SETTINGS.voiceOverlayNotificationActions;
    if (typeof merged.voiceOverlayChat !== "boolean") merged.voiceOverlayChat = DEFAULT_SETTINGS.voiceOverlayChat;
    if (typeof merged.voiceOverlayChatActions !== "boolean") merged.voiceOverlayChatActions = DEFAULT_SETTINGS.voiceOverlayChatActions;
    if (typeof merged.voiceOverlayChatCompose !== "boolean") merged.voiceOverlayChatCompose = DEFAULT_SETTINGS.voiceOverlayChatCompose;
    merged.voiceOverlaySpeakingOpacity = boundedOverlayNumber(merged.voiceOverlaySpeakingOpacity, 20, 100, DEFAULT_SETTINGS.voiceOverlaySpeakingOpacity);
    merged.voiceOverlayIdleOpacity = boundedOverlayNumber(merged.voiceOverlayIdleOpacity, 0, 100, DEFAULT_SETTINGS.voiceOverlayIdleOpacity);
    merged.voiceOverlayScale = boundedOverlayNumber(merged.voiceOverlayScale, 75, 150, DEFAULT_SETTINGS.voiceOverlayScale);
    if (!validOverlayPosition(merged.voiceOverlayPosition)) merged.voiceOverlayPosition = DEFAULT_SETTINGS.voiceOverlayPosition;
    if (merged.voiceOverlayAvatarSize !== "small" && merged.voiceOverlayAvatarSize !== "large") {
      merged.voiceOverlayAvatarSize = DEFAULT_SETTINGS.voiceOverlayAvatarSize;
    }
    if (!(["always", "speaking", "never"] as const).includes(merged.voiceOverlayNameDisplay)) {
      merged.voiceOverlayNameDisplay = DEFAULT_SETTINGS.voiceOverlayNameDisplay;
    }
    merged.voiceOverlayMaxParticipants = Number.isFinite(merged.voiceOverlayMaxParticipants)
      ? Math.max(0, Math.min(25, Math.round(merged.voiceOverlayMaxParticipants)))
      : DEFAULT_SETTINGS.voiceOverlayMaxParticipants;

    // One-time migration: previous default was false; users had it saved as
    // false from before the default flipped. Override once to true.
    try {
      if (!localStorage.getItem(SCREEN_SHARE_AUDIO_MIGRATION_KEY)) {
        merged.screenShareAudio = true;
        localStorage.setItem(SCREEN_SHARE_AUDIO_MIGRATION_KEY, "1");
      }
    } catch { /* localStorage unavailable */ }

    // Hidden paid and obsolete engines migrate to the free default.
    if (REMOVED_ENGINES.has(merged.noiseReductionEngine as string)) {
      merged.noiseReductionEngine = "rnnoise";
      persistNow(merged);
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
}

const DEVICE_LOCAL_KEYS = new Set<keyof VoiceSettings>([
  "inputDevice", "outputDevice", "cameraDevice", "muteHotkeyGlobal",
  "voiceOverlayEnabled", "voiceOverlayMode", "voiceOverlaySpeakingOpacity", "voiceOverlayIdleOpacity",
  "voiceOverlayScale", "voiceOverlayPosition", "voiceOverlaySpeakingOnly",
  "voiceOverlayPinned",
  "voiceOverlayQuickActions", "voiceOverlayClickableActions",
  "voiceOverlayCompatibility",
  "voiceOverlayActivity", "voiceOverlayVideo", "voiceOverlayStreams", "voiceOverlayWelcome", "voiceOverlayGoLive",
  "voiceOverlayGameActivityNotifications", "voiceOverlayNowPlayingNotifications",
  "voiceOverlayNotifications",
  "voiceOverlayNotificationActions",
  "voiceOverlayChat",
  "voiceOverlayChatActions",
  "voiceOverlayChatCompose",
  "voiceOverlayAvatarSize", "voiceOverlayNameDisplay", "voiceOverlayMaxParticipants",
]);
let observedSettings = loadSettings();

/** Register edits immediately, before a concurrent hydration can apply. */
function syncChangedSettings(settings: VoiceSettings): void {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(settings) as (keyof VoiceSettings)[]) {
    if (DEVICE_LOCAL_KEYS.has(key)) continue;
    const value = settings[key];
    const old = observedSettings[key];
    if (JSON.stringify(value) === JSON.stringify(old)) continue;
    if (key === "userVolumes" || key === "screenShareVolumes" || key === "localMutedUsers") {
      const before = old as Record<string, number | boolean>;
      const after = value as Record<string, number | boolean>;
      const changed: Record<string, number | boolean> = {};
      for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[id] !== after[id]) changed[id] = after[id] ?? (key === "localMutedUsers" ? false : 100);
      }
      patch[key] = changed;
    } else {
      patch[key] = value;
    }
  }
  observedSettings = settings;
  if (Object.keys(patch).length) usePreferencesStore.getState().set({ voice_settings: patch });
}

/**
 * Debounce the device cache to avoid serializing it on every slider movement.
 * Register account leaf edits immediately with the preferences queue so an
 * incoming hydration cannot erase a still-debounced local change. That queue
 * independently coalesces network writes; live voice consumers stay immediate.
 */
const SAVE_DEBOUNCE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: VoiceSettings | null = null;

function saveSettings(settings: VoiceSettings): void {
  syncChangedSettings(settings);
  pendingSave = settings;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const toWrite = pendingSave;
    pendingSave = null;
    if (toWrite) persistNow(toWrite);
  }, SAVE_DEBOUNCE_MS);
}

/** Drop a device-cache write superseded by a reconciled snapshot or account reset. */
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
    cameraDevice: s.cameraDevice,
    micProfile: s.micProfile,
    muteHotkeyEnabled: s.muteHotkeyEnabled,
    muteHotkey: s.muteHotkey,
    muteHotkeyGlobal: s.muteHotkeyGlobal,
    voiceOverlayEnabled: s.voiceOverlayEnabled,
    voiceOverlayMode: s.voiceOverlayMode,
    voiceOverlaySpeakingOpacity: s.voiceOverlaySpeakingOpacity,
    voiceOverlayIdleOpacity: s.voiceOverlayIdleOpacity,
    voiceOverlayScale: s.voiceOverlayScale,
    voiceOverlayPosition: s.voiceOverlayPosition,
    voiceOverlayPinned: s.voiceOverlayPinned,
    voiceOverlayQuickActions: s.voiceOverlayQuickActions,
    voiceOverlayClickableActions: s.voiceOverlayClickableActions,
    voiceOverlayCompatibility: s.voiceOverlayCompatibility,
    voiceOverlayActivity: s.voiceOverlayActivity,
    voiceOverlayVideo: s.voiceOverlayVideo,
    voiceOverlayStreams: s.voiceOverlayStreams,
    voiceOverlayWelcome: s.voiceOverlayWelcome,
    voiceOverlayGoLive: s.voiceOverlayGoLive,
    voiceOverlayGameActivityNotifications: s.voiceOverlayGameActivityNotifications,
    voiceOverlayNowPlayingNotifications: s.voiceOverlayNowPlayingNotifications,
    voiceOverlayNotifications: s.voiceOverlayNotifications,
    voiceOverlayNotificationActions: s.voiceOverlayNotificationActions,
    voiceOverlayChat: s.voiceOverlayChat,
    voiceOverlayChatActions: s.voiceOverlayChatActions,
    voiceOverlayChatCompose: s.voiceOverlayChatCompose,
    voiceOverlaySpeakingOnly: s.voiceOverlaySpeakingOnly,
    voiceOverlayAvatarSize: s.voiceOverlayAvatarSize,
    voiceOverlayNameDisplay: s.voiceOverlayNameDisplay,
    voiceOverlayMaxParticipants: s.voiceOverlayMaxParticipants,
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
  setCameraDevice: (deviceId: string) => void;
  setMicProfile: (profile: MicProfile) => void;
  setMuteHotkeyEnabled: (enabled: boolean) => void;
  setMuteHotkey: (key: string) => void;
  setMuteHotkeyGlobal: (enabled: boolean) => void;
  setVoiceOverlayEnabled: (enabled: boolean) => void;
  setVoiceOverlayMode: (mode: "desktop" | "game") => void;
  setVoiceOverlaySpeakingOpacity: (value: number) => void;
  setVoiceOverlayIdleOpacity: (value: number) => void;
  setVoiceOverlayScale: (value: number) => void;
  setVoiceOverlayPosition: (position: VoiceOverlayPosition) => void;
  setVoiceOverlayPinned: (pinned: boolean) => void;
  setVoiceOverlayQuickActions: (enabled: boolean) => void;
  setVoiceOverlayClickableActions: (enabled: boolean) => void;
  setVoiceOverlayCompatibility: (enabled: boolean) => void;
  setVoiceOverlayActivity: (enabled: boolean) => void;
  setVoiceOverlayVideo: (enabled: boolean) => void;
  setVoiceOverlayStreams: (enabled: boolean) => void;
  setVoiceOverlayWelcome: (enabled: boolean) => void;
  setVoiceOverlayGoLive: (enabled: boolean) => void;
  setVoiceOverlayGameActivityNotifications: (enabled: boolean) => void;
  setVoiceOverlayNowPlayingNotifications: (enabled: boolean) => void;
  setVoiceOverlayNotifications: (enabled: boolean) => void;
  setVoiceOverlayNotificationActions: (enabled: boolean) => void;
  setVoiceOverlayChat: (enabled: boolean) => void;
  setVoiceOverlayChatActions: (enabled: boolean) => void;
  setVoiceOverlayChatCompose: (enabled: boolean) => void;
  setVoiceOverlaySpeakingOnly: (enabled: boolean) => void;
  setVoiceOverlayAvatarSize: (size: "small" | "large") => void;
  setVoiceOverlayNameDisplay: (mode: "always" | "speaking" | "never") => void;
  setVoiceOverlayMaxParticipants: (value: number) => void;
  setNoiseReduction: (enabled: boolean) => void;
  setNoiseReductionEngine: (engine: NoiseReductionEngine) => void;
  setNoiseSuppressionLevel: (level: NoiseSuppressionLevel) => void;
  setDeepfilterSuppression: (value: number) => void;
  toggleLocalMute: (userId: string) => void;
  applyFromServer: (settings: Record<string, unknown>) => void;
  resetAccountPreferences: (preserveSessionState?: boolean) => void;
};

export const createVoiceSettingsSlice: StateCreator<
  VoiceStore,
  [],
  [],
  VoiceSettingsSlice
> = (set, get) => {
  const initial = loadSettings();
  observedSettings = initial;

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
    cameraDevice: initial.cameraDevice,
    micProfile: initial.micProfile,
    muteHotkeyEnabled: initial.muteHotkeyEnabled,
    muteHotkey: initial.muteHotkey,
    muteHotkeyGlobal: initial.muteHotkeyGlobal,
    voiceOverlayEnabled: initial.voiceOverlayEnabled,
    voiceOverlayMode: initial.voiceOverlayMode,
    voiceOverlaySpeakingOpacity: initial.voiceOverlaySpeakingOpacity,
    voiceOverlayIdleOpacity: initial.voiceOverlayIdleOpacity,
    voiceOverlayScale: initial.voiceOverlayScale,
    voiceOverlayPosition: initial.voiceOverlayPosition,
    voiceOverlayPinned: initial.voiceOverlayPinned,
    voiceOverlayQuickActions: initial.voiceOverlayQuickActions,
    voiceOverlayClickableActions: initial.voiceOverlayClickableActions,
    voiceOverlayCompatibility: initial.voiceOverlayCompatibility,
    voiceOverlayActivity: initial.voiceOverlayActivity,
    voiceOverlayVideo: initial.voiceOverlayVideo,
    voiceOverlayStreams: initial.voiceOverlayStreams,
    voiceOverlayWelcome: initial.voiceOverlayWelcome,
    voiceOverlayGoLive: initial.voiceOverlayGoLive,
    voiceOverlayGameActivityNotifications: initial.voiceOverlayGameActivityNotifications,
    voiceOverlayNowPlayingNotifications: initial.voiceOverlayNowPlayingNotifications,
    voiceOverlayNotifications: initial.voiceOverlayNotifications,
    voiceOverlayNotificationActions: initial.voiceOverlayNotificationActions,
    voiceOverlayChat: initial.voiceOverlayChat,
    voiceOverlayChatActions: initial.voiceOverlayChatActions,
    voiceOverlayChatCompose: initial.voiceOverlayChatCompose,
    voiceOverlaySpeakingOnly: initial.voiceOverlaySpeakingOnly,
    voiceOverlayAvatarSize: initial.voiceOverlayAvatarSize,
    voiceOverlayNameDisplay: initial.voiceOverlayNameDisplay,
    voiceOverlayMaxParticipants: initial.voiceOverlayMaxParticipants,
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

    setCameraDevice: (deviceId: string) => {
      set({ cameraDevice: deviceId });
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
    setVoiceOverlayEnabled: (enabled) => { set({ voiceOverlayEnabled: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayMode: (mode) => {
      set({ voiceOverlayMode: mode === "game" ? "game" : "desktop" });
      saveSettings(currentSettings(get()));
    },
    setVoiceOverlaySpeakingOpacity: (value) => { set({ voiceOverlaySpeakingOpacity: boundedOverlayNumber(value, 20, 100, DEFAULT_SETTINGS.voiceOverlaySpeakingOpacity) }); saveSettings(currentSettings(get())); },
    setVoiceOverlayIdleOpacity: (value) => { set({ voiceOverlayIdleOpacity: boundedOverlayNumber(value, 0, 100, DEFAULT_SETTINGS.voiceOverlayIdleOpacity) }); saveSettings(currentSettings(get())); },
    setVoiceOverlayScale: (value) => { set({ voiceOverlayScale: boundedOverlayNumber(value, 75, 150, DEFAULT_SETTINGS.voiceOverlayScale) }); saveSettings(currentSettings(get())); },
    setVoiceOverlayPosition: (position) => { set({ voiceOverlayPosition: validOverlayPosition(position) ? position : DEFAULT_SETTINGS.voiceOverlayPosition }); saveSettings(currentSettings(get())); },
    setVoiceOverlayPinned: (pinned) => { set({ voiceOverlayPinned: pinned === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayQuickActions: (enabled) => { set({ voiceOverlayQuickActions: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayClickableActions: (enabled) => { set({ voiceOverlayClickableActions: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayCompatibility: (enabled) => { set({ voiceOverlayCompatibility: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayGoLive: (enabled) => { set({ voiceOverlayGoLive: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayGameActivityNotifications: (enabled) => { set({ voiceOverlayGameActivityNotifications: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayNowPlayingNotifications: (enabled) => { set({ voiceOverlayNowPlayingNotifications: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayWelcome: (enabled) => { set({ voiceOverlayWelcome: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayVideo: (enabled) => { set({ voiceOverlayVideo: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayStreams: (enabled) => { set({ voiceOverlayStreams: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayActivity: (enabled) => { set({ voiceOverlayActivity: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayNotifications: (enabled) => { set({ voiceOverlayNotifications: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayNotificationActions: (enabled) => { set({ voiceOverlayNotificationActions: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayChat: (enabled) => { set({ voiceOverlayChat: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayChatActions: (enabled) => { set({ voiceOverlayChatActions: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayChatCompose: (enabled) => { set({ voiceOverlayChatCompose: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlaySpeakingOnly: (enabled) => { set({ voiceOverlaySpeakingOnly: enabled === true }); saveSettings(currentSettings(get())); },
    setVoiceOverlayAvatarSize: (size) => {
      set({ voiceOverlayAvatarSize: size === "large" ? "large" : "small" });
      saveSettings(currentSettings(get()));
    },
    setVoiceOverlayNameDisplay: (mode) => {
      set({ voiceOverlayNameDisplay: mode === "speaking" || mode === "never" ? mode : "always" });
      saveSettings(currentSettings(get()));
    },
    setVoiceOverlayMaxParticipants: (value) => {
      set({ voiceOverlayMaxParticipants: Number.isFinite(value) ? Math.max(0, Math.min(25, Math.round(value))) : DEFAULT_SETTINGS.voiceOverlayMaxParticipants });
      saveSettings(currentSettings(get()));
    },

    setNoiseReduction: (enabled) => {
      set({ noiseReduction: enabled });
      saveSettings(currentSettings(get()));
    },

    setNoiseReductionEngine: (engine) => {
      set({ noiseReductionEngine: REMOVED_ENGINES.has(engine) ? "rnnoise" : engine });
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
      // The preferences store has already overlaid pending local edits on the
      // server snapshot. Persist that reconciled result, not an older timer.
      cancelPendingSave();
      const merged: VoiceSettings = currentSettings(get());
      const keys = Object.keys(settings) as (keyof VoiceSettings)[];
      for (const key of keys) {
        // Hardware IDs and native hotkey scope remain local in both directions.
        if (DEVICE_LOCAL_KEYS.has(key)) continue;
        if (key in merged) {
          if (key === "userVolumes" || key === "screenShareVolumes" || key === "localMutedUsers") {
            (merged as Record<string, unknown>)[key] = { ...merged[key], ...(settings[key] as Record<string, unknown>) };
          } else {
            (merged as Record<string, unknown>)[key] = settings[key];
          }
        }
      }
      if (REMOVED_ENGINES.has(merged.noiseReductionEngine)) {
        merged.noiseReductionEngine = "rnnoise";
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {
        /* ignore */
      }
      observedSettings = merged;
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
        screenShareLowLatency: merged.screenShareLowLatency,
        screenShareMode: merged.screenShareMode,
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
        voiceOverlayEnabled: merged.voiceOverlayEnabled,
        voiceOverlayMode: merged.voiceOverlayMode,
        voiceOverlaySpeakingOpacity: merged.voiceOverlaySpeakingOpacity,
        voiceOverlayIdleOpacity: merged.voiceOverlayIdleOpacity,
        voiceOverlayScale: merged.voiceOverlayScale,
        voiceOverlayPosition: merged.voiceOverlayPosition,
        voiceOverlayPinned: merged.voiceOverlayPinned,
        voiceOverlayQuickActions: merged.voiceOverlayQuickActions,
        voiceOverlayClickableActions: merged.voiceOverlayClickableActions,
        voiceOverlayCompatibility: merged.voiceOverlayCompatibility,
        voiceOverlayActivity: merged.voiceOverlayActivity,
        voiceOverlayVideo: merged.voiceOverlayVideo,
        voiceOverlayStreams: merged.voiceOverlayStreams,
        voiceOverlayWelcome: merged.voiceOverlayWelcome,
        voiceOverlayGoLive: merged.voiceOverlayGoLive,
        voiceOverlayGameActivityNotifications: merged.voiceOverlayGameActivityNotifications,
        voiceOverlayNowPlayingNotifications: merged.voiceOverlayNowPlayingNotifications,
        voiceOverlayNotifications: merged.voiceOverlayNotifications,
        voiceOverlayNotificationActions: merged.voiceOverlayNotificationActions,
        voiceOverlayChat: merged.voiceOverlayChat,
        voiceOverlayChatActions: merged.voiceOverlayChatActions,
        voiceOverlayChatCompose: merged.voiceOverlayChatCompose,
        voiceOverlaySpeakingOnly: merged.voiceOverlaySpeakingOnly,
        voiceOverlayAvatarSize: merged.voiceOverlayAvatarSize,
        voiceOverlayNameDisplay: merged.voiceOverlayNameDisplay,
        voiceOverlayMaxParticipants: merged.voiceOverlayMaxParticipants,
        // muteHotkeyGlobal intentionally omitted — device-local, see the
        // field's doc comment and the `continue` above.
      });
    },
    resetAccountPreferences: (preserveSessionState = false) => {
      cancelPendingSave();
      const current = get();
      const defaults: VoiceSettings = {
        ...DEFAULT_SETTINGS, userVolumes: {}, screenShareVolumes: {}, localMutedUsers: {},
        inputDevice: current.inputDevice, outputDevice: current.outputDevice,
        cameraDevice: current.cameraDevice, muteHotkeyGlobal: current.muteHotkeyGlobal,
        voiceOverlayEnabled: current.voiceOverlayEnabled,
        voiceOverlayMode: current.voiceOverlayMode,
        voiceOverlaySpeakingOpacity: current.voiceOverlaySpeakingOpacity,
        voiceOverlayIdleOpacity: current.voiceOverlayIdleOpacity,
        voiceOverlayScale: current.voiceOverlayScale,
        voiceOverlayPosition: current.voiceOverlayPosition,
        voiceOverlayPinned: current.voiceOverlayPinned,
        voiceOverlayQuickActions: current.voiceOverlayQuickActions,
        voiceOverlayClickableActions: current.voiceOverlayClickableActions,
        voiceOverlayCompatibility: current.voiceOverlayCompatibility,
        voiceOverlayActivity: current.voiceOverlayActivity,
        voiceOverlayVideo: current.voiceOverlayVideo,
        voiceOverlayStreams: current.voiceOverlayStreams,
        voiceOverlayWelcome: current.voiceOverlayWelcome,
        voiceOverlayGoLive: current.voiceOverlayGoLive,
        voiceOverlayGameActivityNotifications: current.voiceOverlayGameActivityNotifications,
        voiceOverlayNowPlayingNotifications: current.voiceOverlayNowPlayingNotifications,
        voiceOverlayNotifications: current.voiceOverlayNotifications,
        voiceOverlayNotificationActions: current.voiceOverlayNotificationActions,
        voiceOverlayChat: current.voiceOverlayChat,
        voiceOverlayChatActions: current.voiceOverlayChatActions,
        voiceOverlayChatCompose: current.voiceOverlayChatCompose,
        voiceOverlaySpeakingOnly: current.voiceOverlaySpeakingOnly,
        voiceOverlayAvatarSize: current.voiceOverlayAvatarSize,
        voiceOverlayNameDisplay: current.voiceOverlayNameDisplay,
        voiceOverlayMaxParticipants: current.voiceOverlayMaxParticipants,
      };
      observedSettings = defaults;
      persistNow(defaults);
      set({ ...defaults, preMuteVolumes: preserveSessionState ? current.preMuteVolumes : {} });
    },
  };
};
