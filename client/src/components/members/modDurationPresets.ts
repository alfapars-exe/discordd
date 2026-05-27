/**
 * Moderation duration presets — used by ModDurationPicker.
 *
 * Kept in a sibling module so ModDurationPicker.tsx exports only its
 * component (required for react-refresh/only-export-components — Vite's
 * Fast Refresh boundary must be component-pure).
 */

export type DurationPreset = {
  /** Duration in seconds — sent verbatim to the timeout/ban API. */
  seconds: number;
  /** i18n key under "members" namespace, e.g. "dur_60s". */
  labelKey: string;
};

/** Defaults Discord uses — short to mid range. The 28 d cap matches
 *  the server's max in models/member_timeout.go. */
export const TIMEOUT_PRESETS: DurationPreset[] = [
  { seconds: 60, labelKey: "dur_60s" },
  { seconds: 5 * 60, labelKey: "dur_5m" },
  { seconds: 10 * 60, labelKey: "dur_10m" },
  { seconds: 60 * 60, labelKey: "dur_1h" },
  { seconds: 24 * 60 * 60, labelKey: "dur_1d" },
  { seconds: 7 * 24 * 60 * 60, labelKey: "dur_1w" },
];

/** Temp ban presets — wider range (minutes to a month) since
 *  removing someone for 60 s is rarely worth the audit row. */
export const TEMPBAN_PRESETS: DurationPreset[] = [
  { seconds: 10 * 60, labelKey: "dur_10m" },
  { seconds: 60 * 60, labelKey: "dur_1h" },
  { seconds: 6 * 60 * 60, labelKey: "dur_6h" },
  { seconds: 24 * 60 * 60, labelKey: "dur_1d" },
  { seconds: 7 * 24 * 60 * 60, labelKey: "dur_1w" },
  { seconds: 30 * 24 * 60 * 60, labelKey: "dur_30d" },
];
