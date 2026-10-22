/**
 * useThemeBackground — the active theme's base background (`--bg-1`) as a
 * lower-case `#rrggbb`, for client-side name-style contrast checks (Faz G,
 * Karar G-10). Falls back to the contrast reference for an unknown theme.
 */

import { useSettingsStore } from "../stores/settingsStore";
import { THEMES } from "../styles/themes";
import { CONTRAST_REFERENCE } from "../utils/cosmeticContrast";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function themeBackground(themeId: string): string {
  const palette = (THEMES as Record<string, (typeof THEMES)[keyof typeof THEMES] | undefined>)[themeId];
  const bg = palette?.colors["--bg-1"];
  return typeof bg === "string" && HEX_RE.test(bg) ? bg.toLowerCase() : CONTRAST_REFERENCE;
}

export function useThemeBackground(): string {
  const themeId = useSettingsStore((s) => s.themeId);
  return themeBackground(themeId);
}
