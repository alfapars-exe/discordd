import { create } from "zustand";
import { usePreferencesStore } from "./preferencesStore";
import { capturePreferenceScope } from "./preferenceScope";

export type TimeFormat = "auto" | "12" | "24";
const STORAGE_KEY = "hichat.time-format.v1";

function valid(value: unknown): value is TimeFormat { return value === "auto" || value === "12" || value === "24"; }
function initial(): TimeFormat {
  try { const value = localStorage.getItem(STORAGE_KEY); return valid(value) ? value : "auto"; } catch { return "auto"; }
}

type TimeFormatState = {
  timeFormat: TimeFormat;
  setTimeFormat: (value: TimeFormat) => void;
  applyFromServer: (value: unknown) => void;
  resetAccountPreferences: () => void;
};

export const useTimeFormatStore = create<TimeFormatState>((set) => ({
  timeFormat: initial(),
  setTimeFormat: (timeFormat) => {
    const isCurrent = capturePreferenceScope();
    set({ timeFormat });
    if (!isCurrent()) return;
    try { localStorage.setItem(STORAGE_KEY, timeFormat); } catch { /* best effort */ }
    usePreferencesStore.getState().set({ locale: { timeFormat } });
  },
  applyFromServer: (value) => {
    const candidate = value && typeof value === "object" ? (value as { timeFormat?: unknown }).timeFormat : undefined;
    if (!valid(candidate)) return;
    const isCurrent = capturePreferenceScope();
    set({ timeFormat: candidate });
    if (!isCurrent()) return;
    try { localStorage.setItem(STORAGE_KEY, candidate); } catch { /* best effort */ }
  },
  resetAccountPreferences: () => {
    const isCurrent = capturePreferenceScope();
    set({ timeFormat: "auto" });
    if (!isCurrent()) return;
    try { localStorage.setItem(STORAGE_KEY, "auto"); } catch { /* best effort */ }
  },
}));

export function currentHour12(): boolean | undefined {
  const format = useTimeFormatStore.getState().timeFormat;
  return format === "auto" ? undefined : format === "12";
}
