/** Store-free accessibility preference types and defaults. */
export type Density = "compact" | "default" | "cozy";
export type MessageStyle = "default" | "compact";
export type StickerAnimationMode = "always" | "interaction" | "never";
export type RoleColorMode = "names" | "dots" | "hidden";
export type OfficialMessageStyle = "default" | "subtle" | "prominent";

export type AccessibilityState = {
  // ─── Text Readability ────────────────────────────────────────────────
  /** Body font-size in px. Discord uses 12-24; default 16. */
  chatFontSize: number;
  /** When true, every <a> renders with text-decoration: underline. */
  alwaysUnderlineLinks: boolean;
  /** When true, custom display-name effects (color/font) render; otherwise plain. */
  showDisplayNameStyles: boolean;

  // ─── Visual Density ──────────────────────────────────────────────────
  /** Affects sidebar / channel item / member list paddings via body class. */
  density: Density;
  /** Default style = roomy avatar+author header; compact = inline collapsed. */
  messageStyle: MessageStyle;
  /** Vertical gap between adjacent message groups (different authors). */
  messageGroupGapPx: number;

  // ─── Color & Contrast ────────────────────────────────────────────────
  /** filter: saturate(N%) applied to <body>. 0 = greyscale, 100 = full color. */
  saturation: number;
  /** Apply the saturation filter to custom role colors as well. */
  saturateCustomColors: boolean;
  highContrast: boolean;
  syncHighContrast: boolean;
  showSwitchIndicators: boolean;
  roleColorMode: RoleColorMode;
  officialMessageStyle: OfficialMessageStyle;

  // ─── Reduced Motion ──────────────────────────────────────────────────
  /** Globally cuts transition + animation durations to 0ms. */
  reduceMotion: boolean;
  /** Follow the operating-system prefers-reduced-motion setting. */
  syncReducedMotion: boolean;
  /** Suppress animated server / message emoji (renders the static frame). */
  disableAnimatedEmoji: boolean;
  /** Autoplay attached GIF media. Off = play on hover/click only. */
  autoplayGifs: boolean;
  stickerAnimation: StickerAnimationMode;

  // ─── Audio & Screen Reader ───────────────────────────────────────────
  /** New-message / mention notification sound master volume. 0-100. */
  notificationSoundVolume: number;
  /** Pipe incoming messages through SpeechSynthesis (best effort browser TTS). */
  ttsEnabled: boolean;
  /** Browser speech synthesis rate (0.5-2.0). */
  ttsRate: number;
  /** Minimum lifetime for eligible app-created OS notifications. */
  notificationDuration: 3 | 5 | 10 | 15 | 20;
  showImageDescriptions: boolean;
  legacyComposer: boolean;
};

export const DEFAULT_ACCESSIBILITY: AccessibilityState = {
  chatFontSize: 16,
  alwaysUnderlineLinks: false,
  showDisplayNameStyles: true,
  density: "default",
  messageStyle: "default",
  messageGroupGapPx: 16,
  saturation: 100,
  saturateCustomColors: false,
  highContrast: false,
  syncHighContrast: true,
  showSwitchIndicators: false,
  roleColorMode: "names",
  officialMessageStyle: "default",
  reduceMotion: false,
  syncReducedMotion: true,
  disableAnimatedEmoji: false,
  autoplayGifs: true,
  stickerAnimation: "interaction",
  notificationSoundVolume: 80,
  ttsEnabled: false,
  ttsRate: 1,
  notificationDuration: 5,
  showImageDescriptions: false,
  legacyComposer: false,
};

export const ACCESSIBILITY_BOOLEAN_FIELDS = Object.entries(DEFAULT_ACCESSIBILITY)
  .filter(([, value]) => typeof value === "boolean")
  .map(([key]) => key);
