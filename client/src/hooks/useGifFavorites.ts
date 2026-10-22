/**
 * useGifFavorites — favorite Klipy GIFs synced through user preferences
 * (Faz D1, Karar D-20). No server change: stored under the top-level
 * `gif_favorites` key of `/users/me/preferences` (last writer wins across
 * devices, like every other preference key).
 *
 * Only entries whose `url` AND `preview_url` match KLIPY_REGEX are kept —
 * on write and again on read — so a tampered preferences blob can't turn
 * the picker into a tracking-pixel / arbitrary-URL renderer.
 */

import { useCallback, useMemo } from "react";
import type { GifResult } from "../api/gif";
import { usePreferencesStore } from "../stores/preferencesStore";
import { KLIPY_REGEX } from "../utils/messageParsers";

export const GIF_FAVORITES_KEY = "gif_favorites";
export const MAX_GIF_FAVORITES = 50;

export type ToggleFavoriteResult = "added" | "removed" | "full" | "invalid";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate + normalize one stored/incoming entry; null if unusable. */
export function sanitizeGif(v: unknown): GifResult | null {
  if (!isRecord(v)) return null;
  const { id, title, url, preview_url, width, height } = v;
  if (typeof id !== "string" || !id || id.length > 128) return null;
  if (typeof url !== "string" || !KLIPY_REGEX.test(url)) return null;
  if (typeof preview_url !== "string" || !KLIPY_REGEX.test(preview_url)) return null;
  return {
    id,
    title: typeof title === "string" ? title.slice(0, 200) : "",
    url,
    preview_url,
    width: typeof width === "number" && Number.isFinite(width) ? width : 0,
    height: typeof height === "number" && Number.isFinite(height) ? height : 0,
  };
}

/** Filter, de-duplicate by id (first wins) and cap at MAX_GIF_FAVORITES. */
export function sanitizeGifFavorites(raw: unknown): GifResult[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: GifResult[] = [];
  for (const entry of raw) {
    const gif = sanitizeGif(entry);
    if (!gif || seen.has(gif.id)) continue;
    seen.add(gif.id);
    out.push(gif);
    if (out.length >= MAX_GIF_FAVORITES) break;
  }
  return out;
}

export function useGifFavorites() {
  const raw = usePreferencesStore((s) => s.data[GIF_FAVORITES_KEY]);
  const setPreferences = usePreferencesStore((s) => s.set);

  const favorites = useMemo(() => sanitizeGifFavorites(raw), [raw]);
  const favoriteIds = useMemo(() => new Set(favorites.map((g) => g.id)), [favorites]);

  const isFavorite = useCallback((id: string) => favoriteIds.has(id), [favoriteIds]);

  const toggle = useCallback(
    (gif: GifResult): ToggleFavoriteResult => {
      // Read the freshest value (another toggle may have landed this tick).
      const current = sanitizeGifFavorites(usePreferencesStore.getState().data[GIF_FAVORITES_KEY]);
      if (current.some((g) => g.id === gif.id)) {
        setPreferences({ [GIF_FAVORITES_KEY]: current.filter((g) => g.id !== gif.id) });
        return "removed";
      }
      const clean = sanitizeGif(gif);
      if (!clean) return "invalid";
      if (current.length >= MAX_GIF_FAVORITES) return "full";
      setPreferences({ [GIF_FAVORITES_KEY]: [clean, ...current] });
      return "added";
    },
    [setPreferences],
  );

  return { favorites, isFavorite, toggle };
}
