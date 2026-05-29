/**
 * adminFormat regression tests — lock the formatting contracts that the
 * three platform-admin tables now share, so the extraction can't quietly
 * shift a displayed value (UTC parsing, storage thresholds, relative buckets).
 */

import { describe, it, expect } from "vitest";
import { parseUTC, formatStorage, formatRelativeTime, formatDate } from "./adminFormat";

describe("parseUTC", () => {
  it("treats a suffix-less SQLite timestamp as UTC", () => {
    expect(parseUTC("2026-01-01T00:00:00")).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
  });

  it("does not double-append Z when already present", () => {
    expect(parseUTC("2026-01-01T00:00:00Z")).toBe(parseUTC("2026-01-01T00:00:00"));
  });
});

describe("formatStorage", () => {
  it("shows 0 MB below the 0.01 threshold", () => {
    expect(formatStorage(0)).toBe("0 MB");
    expect(formatStorage(0.005)).toBe("0 MB");
  });

  it("shows KB below 1 MB", () => {
    expect(formatStorage(0.5)).toBe("512 KB");
  });

  it("shows MB with one decimal in the 1..1024 range", () => {
    expect(formatStorage(5.5)).toBe("5.5 MB");
  });

  it("shows GB at or above 1024 MB", () => {
    expect(formatStorage(2048)).toBe("2.0 GB");
    expect(formatStorage(1536)).toBe("1.5 GB");
  });
});

describe("formatRelativeTime", () => {
  const opts = {
    neverLabel: "never",
    justNowLabel: "just now",
    fallback: (iso: string) => `ABS:${iso}`,
  };
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("returns the never label for null", () => {
    expect(formatRelativeTime(null, now, opts)).toBe("never");
  });

  it("returns the just-now label under a minute", () => {
    expect(formatRelativeTime(iso(30_000), now, opts)).toBe("just now");
  });

  it("buckets minutes / hours / days", () => {
    expect(formatRelativeTime(iso(5 * 60_000), now, opts)).toBe("5m");
    expect(formatRelativeTime(iso(2 * 3_600_000), now, opts)).toBe("2h");
    expect(formatRelativeTime(iso(3 * 86_400_000), now, opts)).toBe("3d");
  });

  it("falls back to the absolute formatter past 30 days", () => {
    const old = iso(31 * 86_400_000);
    expect(formatRelativeTime(old, now, opts)).toBe(`ABS:${old}`);
  });
});

describe("formatDate", () => {
  it("formats a valid ISO date (year is numeric in every locale)", () => {
    expect(formatDate("2026-03-15T00:00:00Z")).toContain("2026");
  });
});
