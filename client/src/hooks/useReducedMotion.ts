/**
 * useReducedMotion — true when the viewer asked for less motion, either via
 * Settings → Accessibility → Reduce Motion or the OS-level
 * `prefers-reduced-motion: reduce` media query (read once per render; no
 * live listener — the in-app toggle is the reactive path).
 */

import { useAccessibilityStore } from "../stores/accessibilityStore";

function osPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useReducedMotion(): boolean {
  const reduceMotion = useAccessibilityStore((s) => s.reduceMotion);
  const syncReducedMotion = useAccessibilityStore((s) => s.syncReducedMotion);
  return reduceMotion || (syncReducedMotion && osPrefersReducedMotion());
}
