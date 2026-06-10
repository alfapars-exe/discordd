/**
 * dateFormat singleton-locale helpers — regression for QA 2026-05-28 bug #4:
 * locale-less toLocale* calls followed the OS/browser locale, so Turkish
 * users saw English-shaped dates regardless of the in-app language picker.
 * These tests flip the REAL i18n singleton (bundled resources, localStorage
 * detection only — see src/i18n) and assert the rendered shape follows it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import i18n from "../i18n";
import { formatDate, formatDateTime, formatTime } from "./dateFormat";

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
