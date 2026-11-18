/**
 * When animated (GIF) avatars play: "hover" = only while the pointer is over
 * them (default), "always" = autoplay. Reduce Motion overrides "always" back
 * to hover-only — see components/shared/Avatar.tsx.
 */
export type AvatarAnimationMode = "hover" | "always";

/** Default blur for the lightning bolts (px) — matches the original hard-coded value. */
export const LIGHTNING_BLUR_DEFAULT = 4;
export const LIGHTNING_BLUR_MIN = 0;
export const LIGHTNING_BLUR_MAX = 20;

/** Default neon intensity (%) — softened from the previous always-on 100. */
export const NEON_INTENSITY_DEFAULT = 60;
export const NEON_INTENSITY_MIN = 0;
export const NEON_INTENSITY_MAX = 100;

/** Blur strength (px) — how strong the frosted-panel backdrop blur is when enabled. */
export const BLUR_STRENGTH_DEFAULT = 20;
export const BLUR_STRENGTH_MIN = 8;
export const BLUR_STRENGTH_MAX = 40;

/** Whole-app UI scale (%). 100 = native size; whole interface zooms uniformly. */
export const UI_SCALE_DEFAULT = 100;
export const UI_SCALE_MIN = 50;
export const UI_SCALE_MAX = 200;
export const UI_SCALE_STEP = 10;

export type AppearancePreferences = {
  blurEnabled: boolean;
  blurStrength: number;
  wallpaperEnabled: boolean;
  lightningEnabled: boolean;
  lightningBlur: number;
  neonEnabled: boolean;
  neonIntensity: number;
  uiScale: number;
  avatarAnimation: AvatarAnimationMode;
};

export const APPEARANCE_DEFAULTS: AppearancePreferences = {
  blurEnabled: false, blurStrength: BLUR_STRENGTH_DEFAULT, wallpaperEnabled: true,
  lightningEnabled: false, lightningBlur: LIGHTNING_BLUR_DEFAULT,
  neonEnabled: false, neonIntensity: NEON_INTENSITY_DEFAULT,
  uiScale: UI_SCALE_DEFAULT, avatarAnimation: "hover",
};

export const APPEARANCE_STORAGE_KEYS = {
  blurEnabled: "mqvi_blur_enabled", blurStrength: "mqvi_blur_strength", wallpaperEnabled: "mqvi_wallpaper_enabled",
  lightningEnabled: "mqvi_lightning_enabled", lightningBlur: "mqvi_lightning_blur", neonEnabled: "mqvi_neon_enabled",
  neonIntensity: "mqvi_neon_intensity", uiScale: "mqvi_ui_scale", avatarAnimation: "hichat-avatar-animation",
} satisfies Record<keyof AppearancePreferences, string>;

export const APPEARANCE_RANGES = {
  blurStrength: [BLUR_STRENGTH_MIN, BLUR_STRENGTH_MAX],
  lightningBlur: [LIGHTNING_BLUR_MIN, LIGHTNING_BLUR_MAX],
  neonIntensity: [NEON_INTENSITY_MIN, NEON_INTENSITY_MAX],
  uiScale: [UI_SCALE_MIN, UI_SCALE_MAX],
} satisfies Record<string, [number, number]>;
