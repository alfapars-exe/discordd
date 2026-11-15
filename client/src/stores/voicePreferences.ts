/** Store-free voice preference types and defaults. Device/account scope lives in voicePreferenceScope. */
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
export type VoiceOverlayPosition = "top-left" | "center-left" | "bottom-left" | "top-right" | "bottom-right";

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
   * Requests H264 instead of VP9 on desktop/browser screen shares, including
   * an active share. Hardware support and latency gains depend on the device.
   * The selected content profile still determines the degradation preference.
   * Default false; codec transitions may briefly interrupt remote video.
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
   * Also applies during an active desktop/browser share.
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
  voiceOverlayMode: "game",
  voiceOverlaySpeakingOpacity: 100,
  voiceOverlayIdleOpacity: 35,
  voiceOverlayScale: 100,
  voiceOverlayPosition: "center-left",
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


/** Persist only the declared preference contract, excluding runtime state and
 * actions from the voice store. Nested preference maps retain their identity.
 */
export function projectVoiceSettings(settings: VoiceSettings): VoiceSettings {
  return Object.fromEntries(
    (Object.keys(DEFAULT_SETTINGS) as (keyof VoiceSettings)[]).map(key => [key, settings[key]]),
  ) as VoiceSettings;
}
