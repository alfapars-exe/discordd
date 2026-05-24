/**
 * Settings Store — settings modal + theme state management.
 *
 * Theme is synced to server via preferencesStore. On app load,
 * localStorage is used as immediate fallback; server preferences
 * override once fetched.
 */

import { create } from "zustand";
import { type ThemeId, DEFAULT_THEME, THEMES, applyTheme } from "../styles/themes";
import { usePreferencesStore } from "./preferencesStore";

const THEME_STORAGE_KEY = "mqvi_theme";
const BLUR_STORAGE_KEY = "mqvi_blur_enabled";
const WALLPAPER_ENABLED_KEY = "mqvi_wallpaper_enabled";
const TRANSPARENT_KEY = "mqvi_transparent_bg";
const LIGHTNING_ENABLED_KEY = "mqvi_lightning_enabled";
const LIGHTNING_BLUR_KEY = "mqvi_lightning_blur";

/** Default blur for the lightning bolts (px) — matches the original hard-coded value. */
const LIGHTNING_BLUR_DEFAULT = 4;
const LIGHTNING_BLUR_MIN = 0;
const LIGHTNING_BLUR_MAX = 20;

function loadPersistedTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored && stored in THEMES) {
      return stored as ThemeId;
    }
  } catch {
    /* localStorage access error */
  }
  return DEFAULT_THEME;
}

function loadPersistedBlur(): boolean {
  try {
    const stored = localStorage.getItem(BLUR_STORAGE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    /* localStorage access error */
  }
  // Heuristic default: disable blur on low-end hardware or when user requests reduced transparency
  if (typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency < 4) {
    return false;
  }
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches) {
    return false;
  }
  return true;
}

function loadPersistedWallpaperEnabled(): boolean {
  try {
    const stored = localStorage.getItem(WALLPAPER_ENABLED_KEY);
    if (stored === "0") return false;
  } catch {
    /* localStorage access error */
  }
  return true;
}

function loadPersistedTransparent(): boolean {
  try {
    const stored = localStorage.getItem(TRANSPARENT_KEY);
    if (stored === "1") return true;
  } catch {
    /* localStorage access error */
  }
  return false;
}

/**
 * Lightning overlay — default OFF (Track X user request). Users opt in
 * via Settings → Appearance. Stored as "0"/"1" to match the blur/wallpaper
 * persistence pattern above.
 */
function loadPersistedLightningEnabled(): boolean {
  try {
    const stored = localStorage.getItem(LIGHTNING_ENABLED_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    /* localStorage access error */
  }
  return false;
}

function loadPersistedLightningBlur(): number {
  try {
    const stored = localStorage.getItem(LIGHTNING_BLUR_KEY);
    if (stored !== null) {
      const px = parseInt(stored, 10);
      if (Number.isFinite(px) && px >= LIGHTNING_BLUR_MIN && px <= LIGHTNING_BLUR_MAX) return px;
    }
  } catch {
    /* localStorage access error */
  }
  return LIGHTNING_BLUR_DEFAULT;
}

/**
 * Push the lightning blur value into a CSS variable on :root so the
 * filter in globals.css picks it up live (no re-render needed since the
 * variable is read by .lightning-bolt's filter declaration directly).
 */
function applyLightningBlur(px: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--lightning-blur", `${px}px`);
}

type SettingsTab =
  | "profile"
  | "appearance"
  | "accessibility"
  | "general"
  | "voice"
  | "security"
  | "encryption"
  | "server-general"
  | "channels"
  | "roles"
  | "members"
  | "invites"
  | "platform"
  | "platform-quota"
  | "platform-servers"
  | "platform-users"
  | "platform-reports"
  | "platform-logs"
  | "platform-connections"
  | "platform-feedback"
  | "feedback"
  | "blocked-users";

type SettingsState = {
  isOpen: boolean;
  activeTab: SettingsTab;
  themeId: ThemeId;
  blurEnabled: boolean;
  wallpaperEnabled: boolean;
  /** Transparent window background — desktop shows through */
  transparentBackground: boolean;
  /** Lightning bolts overlay in the main content area — opt-in (Track X) */
  lightningEnabled: boolean;
  /** Lightning bolt blur in pixels (0–20) — visual softness of the strikes */
  lightningBlur: number;
  /** Live preview blob URL — applied to the app background without persisting. */
  pendingWallpaperPreviewUrl: string | null;

  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setActiveTab: (tab: SettingsTab) => void;
  setTheme: (id: ThemeId) => void;
  setBlurEnabled: (enabled: boolean) => void;
  setWallpaperEnabled: (enabled: boolean) => void;
  setTransparentBackground: (enabled: boolean) => void;
  setLightningEnabled: (enabled: boolean) => void;
  setLightningBlur: (px: number) => void;
  setPendingWallpaperPreviewUrl: (url: string | null) => void;
  /** Apply theme from server preferences (no re-sync to server) */
  applyFromServer: (themeId: string) => void;
};

export type { SettingsTab };

const initialTheme = loadPersistedTheme();
const initialBlur = loadPersistedBlur();
const initialWallpaperEnabled = loadPersistedWallpaperEnabled();
const initialTransparent = loadPersistedTransparent();
const initialLightningEnabled = loadPersistedLightningEnabled();
const initialLightningBlur = loadPersistedLightningBlur();

// Seed the CSS variable so .lightning-bolt's filter reads the user's
// preferred blur from first paint — without this it would start at the
// 4px fallback and snap to the saved value on first setter call.
applyLightningBlur(initialLightningBlur);

export const useSettingsStore = create<SettingsState>((set) => ({
  isOpen: false,
  activeTab: "profile",
  themeId: initialTheme,
  blurEnabled: initialBlur,
  wallpaperEnabled: initialWallpaperEnabled,
  transparentBackground: initialTransparent,
  lightningEnabled: initialLightningEnabled,
  lightningBlur: initialLightningBlur,
  pendingWallpaperPreviewUrl: null,

  openSettings: (tab = "profile") => set({ isOpen: true, activeTab: tab }),
  closeSettings: () => set({ isOpen: false }),
  setActiveTab: (tab) => set({ activeTab: tab }),

  setTheme: (id) => {
    applyTheme(id);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      /* localStorage full or inaccessible */
    }
    set({ themeId: id });
    // Sync to server
    usePreferencesStore.getState().set({ theme: id });
  },

  setBlurEnabled: (enabled) => {
    try {
      localStorage.setItem(BLUR_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      /* localStorage full or inaccessible */
    }
    set({ blurEnabled: enabled });
  },

  setWallpaperEnabled: (enabled) => {
    try {
      localStorage.setItem(WALLPAPER_ENABLED_KEY, enabled ? "1" : "0");
    } catch {
      /* localStorage full or inaccessible */
    }
    set({ wallpaperEnabled: enabled });
  },

  setTransparentBackground: (enabled) => {
    try {
      localStorage.setItem(TRANSPARENT_KEY, enabled ? "1" : "0");
    } catch {
      /* localStorage full or inaccessible */
    }
    // Sync to Electron app settings (requires restart to take effect)
    if (window.electronAPI?.setAppSetting) {
      window.electronAPI.setAppSetting("transparentBackground", enabled);
    }
    // When enabling transparent, disable wallpaper
    if (enabled) {
      try { localStorage.setItem(WALLPAPER_ENABLED_KEY, "0"); } catch { /* */ }
      set({ transparentBackground: true, wallpaperEnabled: false });
    } else {
      set({ transparentBackground: enabled });
    }
  },

  setLightningEnabled: (enabled) => {
    try {
      localStorage.setItem(LIGHTNING_ENABLED_KEY, enabled ? "1" : "0");
    } catch {
      /* localStorage full or inaccessible */
    }
    set({ lightningEnabled: enabled });
  },

  setLightningBlur: (px) => {
    const clamped = Math.max(LIGHTNING_BLUR_MIN, Math.min(LIGHTNING_BLUR_MAX, Math.round(px)));
    try {
      localStorage.setItem(LIGHTNING_BLUR_KEY, String(clamped));
    } catch {
      /* localStorage full or inaccessible */
    }
    applyLightningBlur(clamped);
    set({ lightningBlur: clamped });
  },

  setPendingWallpaperPreviewUrl: (url) => set({ pendingWallpaperPreviewUrl: url }),

  applyFromServer: (themeId: string) => {
    if (themeId in THEMES) {
      const id = themeId as ThemeId;
      applyTheme(id);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, id);
      } catch { /* ignore */ }
      set({ themeId: id });
    }
  },
}));

// Apply persisted theme on module load
applyTheme(initialTheme);
