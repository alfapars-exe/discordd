/**
 * useMediaQuery — Reactive CSS media query hook.
 *
 * Uses window.matchMedia() — only re-renders on breakpoint transitions.
 * SSR-safe: returns false if window is undefined.
 */

import { useEffect, useState } from "react";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    // Guard both SSR (no window) and jsdom test env (window but no matchMedia
    // shim). Falling back to false is safe: it collapses to the desktop /
    // no-touch / non-mobile branch, which is the strictest superset.
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const mql = window.matchMedia(query);

    // Sync on mount in case of SSR hydration mismatch — microtask
    // defer so react-hooks/set-state-in-effect treats it as a
    // post-commit write instead of a cascading render.
    queueMicrotask(() => setMatches(mql.matches));

    function handleChange(e: MediaQueryListEvent) {
      setMatches(e.matches);
    }

    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}

/** Phone + small tablet portrait */
function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 768px)");
}

/** Tablet landscape (includes 768px) */
function useIsTablet(): boolean {
  return useMediaQuery("(max-width: 1024px)");
}

/** True when the primary input is coarse (finger). Preferred over UA sniffing
 *  or `ontouchstart` — hybrid laptops with touchscreens correctly report
 *  `fine` when a mouse is attached, so we only get `coarse` on real touch-
 *  first devices. Used to gate touch-only UX tweaks (skipping auto-focus that
 *  would summon the soft keyboard, blurring inputs before opening overlays). */
function useIsTouch(): boolean {
  return useMediaQuery("(pointer: coarse)");
}

export { useMediaQuery, useIsMobile, useIsTablet, useIsTouch };
