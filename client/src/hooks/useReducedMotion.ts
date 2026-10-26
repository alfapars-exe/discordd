/**
 * useReducedMotion — true when the viewer asked for less motion, either via
 * Settings → Accessibility → Reduce Motion or the OS-level
 * `prefers-reduced-motion: reduce` media query, including live OS changes.
 */

import { useSyncExternalStore } from "react";
import { useAccessibilityStore } from "../stores/accessibilityStore";

function subscribeToOsMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function osPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useReducedMotion(): boolean {
  const reduceMotion = useAccessibilityStore((s) => s.reduceMotion);
  const syncReducedMotion = useAccessibilityStore((s) => s.syncReducedMotion);
  const osReducedMotion = useSyncExternalStore(subscribeToOsMotion, osPrefersReducedMotion, () => false);
  return reduceMotion || (syncReducedMotion && osReducedMotion);
}
