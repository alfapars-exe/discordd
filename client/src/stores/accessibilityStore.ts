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
  type StickerAnimationMode,
  type RoleColorMode,
  type OfficialMessageStyle,
} from "../styles/accessibility";
import { usePreferencesStore } from "./preferencesStore";

const STORAGE_KEY = "tayfa.accessibility.v1";

const NUMBER_LIMITS: Partial<Record<keyof AccessibilityState, readonly [number, number]>> = {
  chatFontSize: [12, 24], messageGroupGapPx: [0, 24], saturation: [0, 100], notificationSoundVolume: [0, 100],
  ttsRate: [0.5, 2], notificationDuration: [3, 20],
};

/** Stored JSON is untrusted; accept only current fields with their runtime types. */
export function sanitizeAccessibilityPreferences(value: unknown): Partial<AccessibilityState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const valid: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_ACCESSIBILITY) as (keyof AccessibilityState)[]) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const item = source[key];
    const limits = NUMBER_LIMITS[key];
    if (limits) {
      if (typeof item === "number" && Number.isFinite(item) && item >= limits[0] && item <= limits[1]) valid[key] = item;
    } else if (key === "density") {
      if (item === "compact" || item === "default" || item === "cozy") valid[key] = item;
    } else if (key === "messageStyle") {
      if (item === "default" || item === "compact") valid[key] = item;
    } else if (key === "stickerAnimation") {
      if (item === "always" || item === "interaction" || item === "never") valid[key] = item;
    } else if (key === "roleColorMode") {
      if (item === "names" || item === "dots" || item === "hidden") valid[key] = item;
    } else if (key === "officialMessageStyle") {
      if (item === "default" || item === "subtle" || item === "prominent") valid[key] = item;
    } else if (typeof item === "boolean") {
      valid[key] = item;
    }
  }
  return valid as Partial<AccessibilityState>;
}

function loadPersisted(): AccessibilityState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ACCESSIBILITY;
    const parsed = sanitizeAccessibilityPreferences(JSON.parse(raw));
    // Merge with defaults so a future field addition doesn't break old
    // clients (older clients miss the new key → fall through to default).
    return { ...DEFAULT_ACCESSIBILITY, ...parsed };
  } catch {
    return DEFAULT_ACCESSIBILITY;
  }
}

function persist(state: AccessibilityState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeAccessibilityPreferences(state)));
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
  setHighContrast: (enabled: boolean) => void;
  setSyncHighContrast: (enabled: boolean) => void;
  setShowSwitchIndicators: (enabled: boolean) => void;
  setRoleColorMode: (mode: RoleColorMode) => void;
  setOfficialMessageStyle: (style: OfficialMessageStyle) => void;
  // ─── Section D setters ──────────────────────────────────────────────
  setReduceMotion: (enabled: boolean) => void;
  setSyncReducedMotion: (enabled: boolean) => void;
  setDisableAnimatedEmoji: (enabled: boolean) => void;
  setAutoplayGifs: (enabled: boolean) => void;
  setStickerAnimation: (mode: StickerAnimationMode) => void;
  // ─── Section E setters ──────────────────────────────────────────────
  setNotificationSoundVolume: (pct: number) => void;
  setTtsEnabled: (enabled: boolean) => void;
  setTtsRate: (rate: number) => void;
  setNotificationDuration: (seconds: 3 | 5 | 10 | 15 | 20) => void;
  setShowImageDescriptions: (enabled: boolean) => void;
  setLegacyComposer: (enabled: boolean) => void;
  // ─── Bulk hydration from server ─────────────────────────────────────
  applyFromServer: (partial: unknown) => void;
  /** Restore every field to DEFAULT_ACCESSIBILITY — used by a future "Reset" button. */
  reset: () => void;
  resetAccountPreferences: () => void;
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
  const safe = sanitizeAccessibilityPreferences(partial);
  if (Object.keys(safe).length === 0) return;
  set(safe);
  const next = { ...get(), ...safe } as AccessibilityState;
  applyAccessibility(next);
  persist(next);
  // The preferences store batches outgoing writes; one set() per setter
  // is fine. Server stores under a single "accessibility" namespace so
  // existing readers don't have to know the shape.
  usePreferencesStore.getState().set({ accessibility: safe });
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
  setHighContrast: (v) => commit(set, get as never, { highContrast: v }),
  setSyncHighContrast: (v) => commit(set, get as never, { syncHighContrast: v }),
  setShowSwitchIndicators: (v) => commit(set, get as never, { showSwitchIndicators: v }),
  setRoleColorMode: (v) => commit(set, get as never, { roleColorMode: v }),
  setOfficialMessageStyle: (v) => commit(set, get as never, { officialMessageStyle: v }),

  setReduceMotion: (v) => commit(set, get as never, { reduceMotion: v }),
  setSyncReducedMotion: (v) => commit(set, get as never, { syncReducedMotion: v }),
  setDisableAnimatedEmoji: (v) => commit(set, get as never, { disableAnimatedEmoji: v }),
  setAutoplayGifs: (v) => commit(set, get as never, { autoplayGifs: v }),
  setStickerAnimation: (v) => commit(set, get as never, { stickerAnimation: v }),

  setNotificationSoundVolume: (pct) => commit(set, get as never, { notificationSoundVolume: clamp(pct, 0, 100) }),
  setTtsEnabled: (v) => commit(set, get as never, { ttsEnabled: v }),
  setTtsRate: (v) => commit(set, get as never, { ttsRate: clamp(v, 0.5, 2) }),
  setNotificationDuration: (v) => {
    if ([3, 5, 10, 15, 20].includes(v)) commit(set, get as never, { notificationDuration: v });
  },
  setShowImageDescriptions: (v) => commit(set, get as never, { showImageDescriptions: v }),
  setLegacyComposer: (v) => commit(set, get as never, { legacyComposer: v }),

  applyFromServer: (partial) => {
    // Hydration updates the local cache without echoing a write to the server.
    const safe = sanitizeAccessibilityPreferences(partial);
    const next = { ...get(), ...safe } as AccessibilityState;
    set(safe);
    applyAccessibility(next);
    persist(next);
  },

  reset: () => commit(set, get as never, { ...DEFAULT_ACCESSIBILITY }),
  resetAccountPreferences: () => {
    set({ ...DEFAULT_ACCESSIBILITY });
    applyAccessibility(DEFAULT_ACCESSIBILITY);
    persist(DEFAULT_ACCESSIBILITY);
  },
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

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const reapply = () => applyAccessibility(useAccessibilityStore.getState());
  for (const query of ["(prefers-reduced-motion: reduce)", "(prefers-contrast: more)", "(forced-colors: active)"]) {
    window.matchMedia(query).addEventListener?.("change", reapply);
  }
}

useAccessibilityStore.subscribe((s) => {
  // Re-apply whenever any field changes — subscribe fires after set().
  applyAccessibility(s);
});
