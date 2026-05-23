/**
 * validation helpers regression tests — locks the contract of the
 * trust-boundary guards (oneOf, hasKeys) so a refactor can't quietly
 * narrow without falling back.
 *
 * These helpers protect localStorage / JSON.parse boundaries; bugs
 * here propagate as corrupted store state, so the contract checks
 * matter more than coverage breadth.
 */

import { describe, it, expect } from "vitest";
import { oneOf, hasKeys } from "./validation";

describe("oneOf", () => {
  const STATUSES = ["online", "idle", "dnd", "offline"] as const;
  type Status = (typeof STATUSES)[number];

  it("returns the value when it matches an allowed string", () => {
    expect(oneOf<Status>("online", STATUSES, "online")).toBe("online");
    expect(oneOf<Status>("dnd", STATUSES, "online")).toBe("dnd");
  });

  it("returns fallback for unknown strings (the main bug class — removed enum)", () => {
    expect(oneOf<Status>("busy", STATUSES, "online")).toBe("online");
    expect(oneOf<Status>("away", STATUSES, "online")).toBe("online");
  });

  it("returns fallback for non-string inputs", () => {
    expect(oneOf<Status>(null, STATUSES, "online")).toBe("online");
    expect(oneOf<Status>(undefined, STATUSES, "online")).toBe("online");
    expect(oneOf<Status>(42, STATUSES, "online")).toBe("online");
    expect(oneOf<Status>({}, STATUSES, "online")).toBe("online");
    expect(oneOf<Status>([], STATUSES, "online")).toBe("online");
  });

  it("returns fallback for empty string (a real localStorage corner case)", () => {
    expect(oneOf<Status>("", STATUSES, "online")).toBe("online");
  });
});

describe("hasKeys", () => {
  it("returns true when all required keys present", () => {
    expect(hasKeys({ a: 1, b: 2 }, ["a", "b"])).toBe(true);
    expect(hasKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(true);
  });

  it("returns false when any required key is missing", () => {
    expect(hasKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(hasKeys({}, ["a"])).toBe(false);
  });

  it("returns false for non-object inputs (the main bug class — corrupted JSON.parse)", () => {
    expect(hasKeys(null, ["a"])).toBe(false);
    expect(hasKeys(undefined, ["a"])).toBe(false);
    expect(hasKeys("string", ["a"])).toBe(false);
    expect(hasKeys(42, ["a"])).toBe(false);
    // Arrays are objects in JS, but the in-operator works on them with
    // numeric indices — guarding still excludes them via the type check
    // upstream. hasKeys itself accepts the array, since string keys
    // *could* match (e.g. ["length"]). Caller responsibility.
  });

  it("returns true with empty requirements (vacuous truth on objects)", () => {
    expect(hasKeys({}, [])).toBe(true);
    expect(hasKeys({ a: 1 }, [])).toBe(true);
  });
});
