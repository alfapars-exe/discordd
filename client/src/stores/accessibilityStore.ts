/**
 * accessibilityStore — user-facing accessibility preferences.
 *
 * Owns the 13 fields rendered by AccessibilitySettings.tsx (font size,
 * density, saturation, reduced motion, etc.). Lives apart from
 * settingsStore (themes/blur/wallpaper) so the two concerns don't
 * grow into each other — they're already conceptually separate in the
 * Discord UI (Görünüm vs Erişilebilirlik tabs) and the persisted
 * keys on the server cleanly partition that way too.
 *
 * Lifecycle (mirrors settingsStore + themesStore):
 *
 *   1. Module load reads cached values from localStorage and seeds the
 *      Zustand state. applyAccessibility runs once with the seeded
 *      values so the DOM matches before any React render.
 *
 *   2. Setters mutate the local state, write back to localStorage,
 *      re-call applyAccessibility (DOM update), and forward the change
 *      to preferencesStore so a cross-device sync happens on next idle.
 *
 *   3. preferencesStore.fetchAndApply (run at app start after auth)
 *      calls applyFromServer here with the freshly loaded server copy
 *      — server wins over localStorage on conflict, same precedence as
 *      themeId / blur today.
 */

import { create } from "zustand";

import {
  applyAccessibility,
  DEFAULT_ACCESSIBILITY,
  type AccessibilityState,
  type Density,
  type MessageStyle,
} from "../styles/accessibility";
import { usePreferencesStore } from "./preferencesStore";

const STORAGE_KEY = "tayfa.accessibility.v1";

function loadPersisted(): AccessibilityState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ACCESSIBILITY;
    const parsed = JSON.parse(raw) as Partial<AccessibilityState>;
    // Merge with defaults so a future field addition doesn't break old
    // clients (older clients miss the new key → fall through to default).
    return { ...DEFAULT_ACCESSIBILITY, ...parsed };
  } catch {
    return DEFAULT_ACCESSIBILITY;
  }
}

function persist(state: AccessibilityState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage quota or denied — no-op, state still works in memory. */
  }
}

type AccessibilityStore = AccessibilityState & {
  // ─── Section A setters ──────────────────────────────────────────────
  setChatFontSize: (px: number) => void;
  setAlwaysUnderlineLinks: (enabled: boolean) => void;
  setShowDisplayNameStyles: (enabled: boolean) => void;
  // ─── Section B setters ──────────────────────────────────────────────
  setDensity: (d: Density) => void;
  setMessageStyle: (s: MessageStyle) => void;
  setMessageGroupGapPx: (px: number) => void;
  // ─── Section C setters ──────────────────────────────────────────────
  setSaturation: (pct: number) => void;
  setSaturateCustomColors: (enabled: boolean) => void;
  // ─── Section D setters ──────────────────────────────────────────────
  setReduceMotion: (enabled: boolean) => void;
  setDisableAnimatedEmoji: (enabled: boolean) => void;
  setAutoplayGifs: (enabled: boolean) => void;
  // ─── Section E setters ──────────────────────────────────────────────
  setNotificationSoundVolume: (pct: number) => void;
  setTtsEnabled: (enabled: boolean) => void;
  // ─── Bulk hydration from server ─────────────────────────────────────
  applyFromServer: (partial: Partial<AccessibilityState>) => void;
  /** Restore every field to DEFAULT_ACCESSIBILITY — used by a future "Reset" button. */
  reset: () => void;
};

const initial = loadPersisted();

/**
 * Internal helper — apply + persist + sync-to-server. Saves us from
 * repeating that boilerplate inside every setter.
 */
function commit(
  set: (partial: Partial<AccessibilityState>) => void,
  get: () => AccessibilityState,
  partial: Partial<AccessibilityState>,
): void {
  set(partial);
  const next = { ...get(), ...partial } as AccessibilityState;
  applyAccessibility(next);
  persist(next);
  // The preferences store batches outgoing writes; one set() per setter
  // is fine. Server stores under a single "accessibility" namespace so
  // existing readers don't have to know the shape.
  usePreferencesStore.getState().set({ accessibility: next });
}

export const useAccessibilityStore = create<AccessibilityStore>((set, get) => ({
  ...initial,

  setChatFontSize: (px) => commit(set, get as never, { chatFontSize: clamp(px, 12, 24) }),
  setAlwaysUnderlineLinks: (v) => commit(set, get as never, { alwaysUnderlineLinks: v }),
  setShowDisplayNameStyles: (v) => commit(set, get as never, { showDisplayNameStyles: v }),

  setDensity: (d) => commit(set, get as never, { density: d }),
  setMessageStyle: (s) => commit(set, get as never, { messageStyle: s }),
  setMessageGroupGapPx: (px) => commit(set, get as never, { messageGroupGapPx: clamp(px, 0, 24) }),

  setSaturation: (pct) => commit(set, get as never, { saturation: clamp(pct, 0, 100) }),
  setSaturateCustomColors: (v) => commit(set, get as never, { saturateCustomColors: v }),

  setReduceMotion: (v) => commit(set, get as never, { reduceMotion: v }),
  setDisableAnimatedEmoji: (v) => commit(set, get as never, { disableAnimatedEmoji: v }),
  setAutoplayGifs: (v) => commit(set, get as never, { autoplayGifs: v }),

  setNotificationSoundVolume: (pct) => commit(set, get as never, { notificationSoundVolume: clamp(pct, 0, 100) }),
  setTtsEnabled: (v) => commit(set, get as never, { ttsEnabled: v }),

  applyFromServer: (partial) => {
    // No persist + no server-sync here — that's the same precedence rule
    // settingsStore.applyFromServer uses (server's source of truth gets
    // mirrored locally without echoing back to the server).
    const next = { ...get(), ...partial } as AccessibilityState;
    set(partial);
    applyAccessibility(next);
    persist(next);
  },

  reset: () => commit(set, get as never, { ...DEFAULT_ACCESSIBILITY }),
}));

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// Apply once at module load so the DOM has the right CSS variables before
// the first React render. The Zustand subscribe below catches every later
// mutation, but boot-time apply must be synchronous to avoid a flash of
// default values during initial render.
applyAccessibility(initial);

useAccessibilityStore.subscribe((s) => {
  // Re-apply whenever any field changes — subscribe fires after set().
  applyAccessibility(s);
});
