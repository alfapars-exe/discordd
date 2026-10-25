/**
 * useEntranceListenerPrefs — the listener-side entrance-sound setting
 * (Faz E, Karar E-12), synced through user preferences under the top-level
 * `entrance_sounds` key: `{ enabled: boolean, volume: 0–100 }`.
 * A missing/corrupt value falls back to `{ enabled: true, volume: 70 }`.
 */

import { useCallback, useMemo } from "react";
import { usePreferencesStore } from "../stores/preferencesStore";

export const ENTRANCE_PREFS_KEY = "entrance_sounds";

export type EntranceListenerPrefs = { enabled: boolean; volume: number };

export const DEFAULT_ENTRANCE_PREFS: EntranceListenerPrefs = { enabled: true, volume: 70 };

/** Normalizes a stored value; never throws. */
export function sanitizeEntrancePrefs(raw: unknown): EntranceListenerPrefs {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_ENTRANCE_PREFS;
  const rec = raw as Record<string, unknown>;
  const enabled = typeof rec.enabled === "boolean" ? rec.enabled : DEFAULT_ENTRANCE_PREFS.enabled;
  const volume =
    typeof rec.volume === "number" && Number.isFinite(rec.volume)
      ? Math.round(Math.min(100, Math.max(0, rec.volume)))
      : DEFAULT_ENTRANCE_PREFS.volume;
  return { enabled, volume };
}

/** Non-React read (WS handler). */
export function getEntranceListenerPrefs(): EntranceListenerPrefs {
  return sanitizeEntrancePrefs(usePreferencesStore.getState().data[ENTRANCE_PREFS_KEY]);
}

export function useEntranceListenerPrefs() {
  const raw = usePreferencesStore((s) => s.data[ENTRANCE_PREFS_KEY]);
  const setPreferences = usePreferencesStore((s) => s.set);
  const prefs = useMemo(() => sanitizeEntrancePrefs(raw), [raw]);

  const update = useCallback(
    (patch: Partial<EntranceListenerPrefs>) => {
      const next = sanitizeEntrancePrefs({ ...getEntranceListenerPrefs(), ...patch });
      setPreferences({ [ENTRANCE_PREFS_KEY]: {
        ...(patch.enabled !== undefined ? { enabled: next.enabled } : {}),
        ...(patch.volume !== undefined ? { volume: next.volume } : {}),
      } });
    },
    [setPreferences],
  );

  return { prefs, update };
}
