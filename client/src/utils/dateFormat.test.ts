/**
 * dateFormat singleton-locale helpers — regression for QA 2026-05-28 bug #4:
 * locale-less toLocale* calls followed the OS/browser locale, so Turkish
 * users saw English-shaped dates regardless of the in-app language picker.
 * These tests flip the REAL i18n singleton (bundled resources, localStorage
 * detection only — see src/i18n) and assert the rendered shape follows it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import i18n from "../i18n";
import { formatDate, formatDateTime, formatTime, lastSeenLabel } from "./dateFormat";

// Noon, local time — keeps the calendar day stable in every CI timezone.
// December so the short month name differs between tr ("Ara") and en ("Dec").
const sample = new Date(2026, 11, 15, 12, 30);

const originalLanguage = i18n.language;

afterAll(async () => {
  await i18n.changeLanguage(originalLanguage);
});

describe("with Turkish active", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });

  it("formatDate renders day.month.year ordering", () => {
    expect(formatDate(sample)).toBe("15.12.2026");
  });

  it("formatDateTime leads with the tr-shaped date", () => {
    expect(formatDateTime(sample)).toContain("15.12.2026");
  });

  it("formatTime renders 24-hour clock", () => {
    expect(formatTime(sample, { hour: "2-digit", minute: "2-digit" })).toBe("12:30");
  });

  it("passes options through (tr short month)", () => {
    const label = formatDate(sample, { year: "numeric", month: "short", day: "numeric" });
    expect(label).toContain("Ara");
  });

  it("accepts ISO string input", () => {
    expect(formatDate("2026-12-15T12:30:00")).toBe("15.12.2026");
  });
});

describe("with English active", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("formatDate renders month/day/year ordering", () => {
    expect(formatDate(sample)).toBe("12/15/2026");
  });

  it("formatDateTime leads with the en-shaped date", () => {
    expect(formatDateTime(sample)).toContain("12/15/2026");
  });

  it("passes options through (en short month)", () => {
    const label = formatDate(sample, { year: "numeric", month: "short", day: "numeric" });
    expect(label).toContain("Dec");
  });
});

describe("lastSeenLabel", () => {
  // Fixed "now" so each case just needs a delta rather than real wall-clock time.
  const now = Date.parse("2026-07-19T12:00:00Z");
  const minutesAgo = (n: number) => now - n * 60_000;
  const hoursAgo = (n: number) => now - n * 3_600_000;
  const daysAgo = (n: number) => now - n * 86_400_000;

  it("30 seconds ago renders 'just now'", () => {
    expect(lastSeenLabel(now - 30_000, now, "en")).toEqual({ key: "lastSeenJustNow" });
  });

  it("20 minutes ago renders exact minutes", () => {
    expect(lastSeenLabel(minutesAgo(20), now, "en")).toEqual({
      key: "lastSeenMinutes",
      values: { count: 20 },
    });
  });

  it("59 minutes ago renders exact minutes (upper bound)", () => {
    expect(lastSeenLabel(minutesAgo(59), now, "en")).toEqual({
      key: "lastSeenMinutes",
      values: { count: 59 },
    });
  });

  it("1h20m ago renders exact hours+minutes", () => {
    expect(lastSeenLabel(minutesAgo(80), now, "en")).toEqual({
      key: "lastSeenHoursMinutes",
      values: { hours: 1, minutes: 20 },
    });
  });

  it("exactly 2 hours ago renders exact hours (no minutes remainder)", () => {
    expect(lastSeenLabel(hoursAgo(2), now, "en")).toEqual({
      key: "lastSeenHours",
      values: { count: 2 },
    });
  });

  it("2h59m ago still renders exact hours+minutes (below the 3h threshold)", () => {
    expect(lastSeenLabel(minutesAgo(179), now, "en")).toEqual({
      key: "lastSeenHoursMinutes",
      values: { hours: 2, minutes: 59 },
    });
  });

  it("3 hours ago switches to rounded approximation", () => {
    expect(lastSeenLabel(hoursAgo(3), now, "en")).toEqual({
      key: "lastSeenApproxHours",
      values: { count: 3 },
    });
  });

  it("exactly 1 day ago renders the singular day key", () => {
    expect(lastSeenLabel(daysAgo(1), now, "en")).toEqual({ key: "lastSeenDaySingular" });
  });

  it("2 days ago renders exact days", () => {
    expect(lastSeenLabel(daysAgo(2), now, "en")).toEqual({
      key: "lastSeenDays",
      values: { count: 2 },
    });
  });

  it("29 days ago still renders exact days (below the 30d threshold)", () => {
    expect(lastSeenLabel(daysAgo(29), now, "en")).toEqual({
      key: "lastSeenDays",
      values: { count: 29 },
    });
  });

  it("31 days ago falls back to an absolute date", () => {
    const result = lastSeenLabel(daysAgo(31), now, "en");
    expect(result.key).toBe("lastSeenAbsoluteDate");
    expect(typeof result.values?.date).toBe("string");
  });
});
