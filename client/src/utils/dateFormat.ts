/**
 * dateFormat — Discord-style message timestamp formatting.
 *
 * Format rules:
 * - Today:        "22:15"
 * - Yesterday:    "Yesterday 22:15"
 * - This week:    "Friday 22:15"
 * - This year:    "1 March 22:15"
 * - Older:        "27 February 2025 22:15"
 *
 * Locale param comes from i18next.language — auto-localizes day/month names.
 */

import i18n from "../i18n";

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatTimeOnly(date: Date, locale: string): string {
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Formats message timestamp to a human-friendly short format.
 *
 * @param dateStr - ISO 8601 date string (backend created_at)
 * @param locale  - i18next.language value ("tr", "en", etc.)
 * @param labels  - i18n labels: { yesterday: string }
 */
export function formatMessageTime(
  dateStr: string,
  locale: string,
  labels: { yesterday: string }
): string {
  const date = new Date(dateStr);
  const now = new Date();

  const todayStart = startOfDay(now);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);

  const time = formatTimeOnly(date, locale);

  // Today
  if (date >= todayStart) {
    return time;
  }

  // Yesterday
  if (date >= yesterdayStart) {
    return `${labels.yesterday} ${time}`;
  }

  // Last 7 days
  if (date >= weekStart) {
    const dayName = date.toLocaleDateString(locale, { weekday: "long" });
    const capitalized = dayName.charAt(0).toUpperCase() + dayName.slice(1);
    return `${capitalized} ${time}`;
  }

  // This year
  if (date.getFullYear() === now.getFullYear()) {
    const datePart = date.toLocaleDateString(locale, { day: "numeric", month: "long" });
    return `${datePart} ${time}`;
  }

  // Older
  const datePart = date.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `${datePart} ${time}`;
}

/** Full date format for hover tooltip: "01/03/2025 22:15" */
export function formatFullDateTime(dateStr: string, locale: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Localised future-relative duration ("in 5 minutes" / "5 dakika sonra").
 * Uses Intl.RelativeTimeFormat so the language matches i18next.language
 * without hardcoding translations. Picks the largest sensible unit:
 * sub-minute → "in 30 seconds", under an hour → minutes, etc.
 *
 * Returns the absolute date if the target is more than 28 days out
 * (matches the timeout max so the UI never says "in 1 month") and
 * "now" for anything in the past — callers should normally avoid
 * passing past dates since the server filters expired rows, but the
 * fallback keeps the UI sensible if a stale ISO leaks through.
 */
export function formatRelativeFuture(toIso: string, locale: string): string {
  const now = Date.now();
  const target = Date.parse(toIso);
  if (Number.isNaN(target)) return "";

  const diffSec = Math.round((target - now) / 1000);
  if (diffSec <= 0) {
    // already past — caller should usually have cleared the entry by now
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second");
  }

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (diffSec < 60) return rtf.format(diffSec, "second");
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return rtf.format(diffMin, "minute");
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return rtf.format(diffHr, "hour");
  const diffDay = Math.round(diffHr / 24);
  if (diffDay <= 28) return rtf.format(diffDay, "day");
  // Past 28 days — fall back to absolute date so we don't say "in 2 months"
  // for a 30-day temp ban.
  return formatFullDateTime(toIso, locale);
}

// ─── Singleton-locale helpers (QA 2026-05-28 bug #4) ───
//
// Hardcoded/default-locale toLocale* calls rendered English-shaped dates for
// Turkish users: with no locale argument the runtime falls back to the
// OS/browser locale, ignoring the in-app language picker. These helpers read
// i18n.language at call time so every timestamp follows the chosen language.

/** Date-only label in the current UI language. */
export function formatDate(
  iso: string | number | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Date(iso).toLocaleDateString(i18n.language, options);
}

/** Date+time label in the current UI language. */
export function formatDateTime(
  iso: string | number | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Date(iso).toLocaleString(i18n.language, options);
}

/** Time-only label in the current UI language. */
export function formatTime(
  iso: string | number | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Date(iso).toLocaleTimeString(i18n.language, options);
}

// ─── Offline "last seen" relative label ───

/** i18n key + interpolation values for a `lastSeenLabel` result; the
 *  caller renders it via `t(key, values)` since this module stays
 *  i18next-free (pure formatting logic, easy to unit test). */
export type LastSeenLabel = { key: string; values?: Record<string, number | string> };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Below this, hours+minutes render exact; at/above it, hours are rounded ("about X hours ago"). */
const APPROX_HOUR_THRESHOLD_MS = 3 * HOUR_MS;
/** At/above this many days, fall back to an absolute date instead of a relative count. */
const ABSOLUTE_DATE_THRESHOLD_DAYS = 30;

/**
 * Builds a graduated relative "last seen" label from a past timestamp:
 * <1min "just now" → exact minutes → exact hours+minutes (<3h) →
 * rounded hours (3h-24h) → exact days (<30d) → absolute date (30d+).
 *
 * @param lastSeenMs - the last-seen timestamp, epoch ms
 * @param nowMs      - current time, epoch ms (pass a ticking snapshot from
 *                     useNowTick so this stays a pure function of its args)
 * @param locale     - i18next language code, used only for the 30+ day
 *                     absolute-date branch
 */
export function lastSeenLabel(lastSeenMs: number, nowMs: number, locale: string): LastSeenLabel {
  const diffMs = nowMs - lastSeenMs;
  if (diffMs < 60_000) return { key: "lastSeenJustNow" };

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return { key: "lastSeenMinutes", values: { count: minutes } };

  if (diffMs < APPROX_HOUR_THRESHOLD_MS) {
    const hours = Math.floor(diffMs / HOUR_MS);
    const remMinutes = minutes % 60;
    if (remMinutes === 0) return { key: "lastSeenHours", values: { count: hours } };
    return { key: "lastSeenHoursMinutes", values: { hours, minutes: remMinutes } };
  }

  if (diffMs < DAY_MS) {
    const hours = Math.round(diffMs / HOUR_MS);
    return { key: "lastSeenApproxHours", values: { count: hours } };
  }

  const days = Math.floor(diffMs / DAY_MS);
  if (days < ABSOLUTE_DATE_THRESHOLD_DAYS) {
    if (days === 1) return { key: "lastSeenDaySingular" };
    return { key: "lastSeenDays", values: { count: days } };
  }

  const formatted = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(lastSeenMs));
  return { key: "lastSeenAbsoluteDate", values: { date: formatted } };
}
