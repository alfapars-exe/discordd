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
