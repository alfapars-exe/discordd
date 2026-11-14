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

import { type AccessibilityState, type Density } from "../utils/accessibilityPreferenceDefaults";
export { DEFAULT_ACCESSIBILITY } from "../utils/accessibilityPreferenceDefaults";
export type { Density, MessageStyle, StickerAnimationMode, RoleColorMode, OfficialMessageStyle, AccessibilityState } from "../utils/accessibilityPreferenceDefaults";

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
  const osReduced = s.syncReducedMotion && typeof window !== "undefined" &&
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const effectiveReducedMotion = s.reduceMotion || osReduced;
  const osHighContrast = s.syncHighContrast && typeof window !== "undefined" &&
    typeof window.matchMedia === "function" && (
      window.matchMedia("(prefers-contrast: more)").matches || window.matchMedia("(forced-colors: active)").matches
    );
  root.style.setProperty(
    "--motion-duration",
    effectiveReducedMotion ? "0ms" : "200ms",
  );
  // `--motion-scale` is consumed by transform-based hover effects so they
  // collapse to no movement instead of an animation that just runs faster.
  root.style.setProperty("--motion-scale", effectiveReducedMotion ? "1" : "1.05");

  // ─── Body modifier classes (presence-based switches) ──────────────────
  const body = document.body;
  body.classList.toggle("density-compact", s.density === "compact");
  body.classList.toggle("density-cozy", s.density === "cozy");
  body.classList.toggle("msg-style-compact", s.messageStyle === "compact");
  body.classList.toggle("saturate-custom", s.saturateCustomColors);
  body.classList.toggle("no-animated-emoji", s.disableAnimatedEmoji);
  body.classList.toggle("no-gif-autoplay", !s.autoplayGifs);
  body.classList.toggle("display-name-plain", !s.showDisplayNameStyles);
  body.classList.toggle("reduce-motion", effectiveReducedMotion);
  body.classList.toggle("high-contrast", s.highContrast || osHighContrast);
  body.classList.toggle("switch-indicators", s.showSwitchIndicators);
}
