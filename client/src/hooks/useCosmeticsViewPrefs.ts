/**
 * useCosmeticsViewPrefs — viewer-side cosmetics setting (Faz G, Karar G-17),
 * synced through user preferences under the top-level `cosmetics_view` key:
 * `{ plain: boolean }`. With `plain` on, OTHER users' cosmetics are hidden
 * (your own and the settings preview stay visible). A missing/corrupt value
 * falls back to `{ plain: false }`.
 */

import { useCallback, useMemo } from "react";
import { usePreferencesStore } from "../stores/preferencesStore";

export const COSMETICS_VIEW_KEY = "cosmetics_view";

export type CosmeticsViewPrefs = { plain: boolean };

export const DEFAULT_COSMETICS_VIEW: CosmeticsViewPrefs = { plain: false };

/** Normalizes a stored value; never throws. */
export function sanitizeCosmeticsView(raw: unknown): CosmeticsViewPrefs {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_COSMETICS_VIEW;
  const plain = (raw as Record<string, unknown>).plain;
  return typeof plain === "boolean" ? { plain } : DEFAULT_COSMETICS_VIEW;
}

/** Narrow selector for hot paths (message rows): only the boolean. */
export function useCosmeticsPlainView(): boolean {
  return usePreferencesStore((s) => sanitizeCosmeticsView(s.data[COSMETICS_VIEW_KEY]).plain);
}

export function useCosmeticsViewPrefs() {
  const raw = usePreferencesStore((s) => s.data[COSMETICS_VIEW_KEY]);
  const setPreferences = usePreferencesStore((s) => s.set);
  const prefs = useMemo(() => sanitizeCosmeticsView(raw), [raw]);

  const update = useCallback(
    (patch: Partial<CosmeticsViewPrefs>) => {
      const current = sanitizeCosmeticsView(usePreferencesStore.getState().data[COSMETICS_VIEW_KEY]);
      setPreferences({ [COSMETICS_VIEW_KEY]: sanitizeCosmeticsView({ ...current, ...patch }) });
    },
    [setPreferences],
  );

  return { prefs, update };
}
