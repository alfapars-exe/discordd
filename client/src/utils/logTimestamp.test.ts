import { expect, it } from "vitest";
import { normalizeLogTimestamp } from "./logTimestamp";

it("normalizes SQLite UTC and preserves PostgreSQL offsets", () => {
  expect(normalizeLogTimestamp("2026-10-25 12:30:00")).toBe("2026-10-25T12:30:00Z");
  expect(normalizeLogTimestamp("2026-10-25T12:30:00+00:00")).toBe("2026-10-25T12:30:00+00:00");
  expect(normalizeLogTimestamp("2026-10-25T15:30:00+03:00")).toBe("2026-10-25T15:30:00+03:00");
  expect(normalizeLogTimestamp("2026-10-25T12:30:00.123Z")).toBe("2026-10-25T12:30:00.123Z");
});
