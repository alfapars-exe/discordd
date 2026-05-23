/**
 * accessibility.ts — apply user accessibility prefs to the DOM.
 *
 * Mirrors the design of styles/themes.ts:applyTheme — every preference
 * lands as a CSS custom property on :root (or a body class for boolean
 * "mode switches" like density-cozy) so the rest of the app reads them
 * via `var(--*)` and updates instantly when the value changes.
 *
 * The accessibilityStore module calls this:
 *   - once at boot from main.tsx (after the persisted state hydrates)
 *   - again on every state mutation via a Zustand subscribe
 *
 * Doing the application in one place instead of scattering setProperty
 * calls through individual setters keeps "what does setting X change"
 * trivially auditable: open this file, find the line, that's the entire
 * contract.
 */

export type Density = "compact" | "default" | "cozy";
export type MessageStyle = "default" | "compact";

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

  // ─── Reduced Motion ──────────────────────────────────────────────────
  /** Globally cuts transition + animation durations to 0ms. */
  reduceMotion: boolean;
  /** Suppress animated server / message emoji (renders the static frame). */
  disableAnimatedEmoji: boolean;
  /** Autoplay attached GIF media. Off = play on hover/click only. */
  autoplayGifs: boolean;

  // ─── Audio & Screen Reader ───────────────────────────────────────────
  /** New-message / mention notification sound master volume. 0-100. */
  notificationSoundVolume: number;
  /** Pipe incoming messages through SpeechSynthesis (best effort browser TTS). */
  ttsEnabled: boolean;
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
  reduceMotion: false,
  disableAnimatedEmoji: false,
  autoplayGifs: true,
  notificationSoundVolume: 80,
  ttsEnabled: false,
};

/** Map the density radio onto a multiplier consumed by spacing CSS. */
function densityScale(d: Density): string {
  if (d === "compact") return "0.85";
  if (d === "cozy") return "1.15";
  return "1.0";
}

/**
 * Apply the entire accessibility state to the DOM.
 *
 * Safe to call repeatedly — each call just overwrites the relevant
 * custom properties / body classes. There is no diff'ing because the
 * cost of setProperty on a dozen entries is cheap; ten thousand of
 * them per second wouldn't move the needle.
 */
export function applyAccessibility(s: AccessibilityState): void {
  const root = document.documentElement;

  // ─── CSS custom properties (consumed by globals.css rules) ────────────
  root.style.setProperty("--chat-font-size", `${s.chatFontSize}px`);
  root.style.setProperty(
    "--link-decoration",
    s.alwaysUnderlineLinks ? "underline" : "none",
  );
  root.style.setProperty("--density-scale", densityScale(s.density));
  root.style.setProperty("--msg-group-gap", `${s.messageGroupGapPx}px`);
  root.style.setProperty("--saturation", `${s.saturation}%`);
  root.style.setProperty(
    "--motion-duration",
    s.reduceMotion ? "0ms" : "200ms",
  );
  // `--motion-scale` is consumed by transform-based hover effects so they
  // collapse to no movement instead of an animation that just runs faster.
  root.style.setProperty("--motion-scale", s.reduceMotion ? "1" : "1.05");

  // ─── Body modifier classes (presence-based switches) ──────────────────
  const body = document.body;
  body.classList.toggle("density-compact", s.density === "compact");
  body.classList.toggle("density-cozy", s.density === "cozy");
  body.classList.toggle("msg-style-compact", s.messageStyle === "compact");
  body.classList.toggle("saturate-custom", s.saturateCustomColors);
  body.classList.toggle("no-animated-emoji", s.disableAnimatedEmoji);
  body.classList.toggle("no-gif-autoplay", !s.autoplayGifs);
  body.classList.toggle("display-name-plain", !s.showDisplayNameStyles);
  body.classList.toggle("reduce-motion", s.reduceMotion);
}
