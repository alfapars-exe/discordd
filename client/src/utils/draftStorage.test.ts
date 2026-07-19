import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  MAX_DRAFT_CHARS,
  clearAllDrafts,
  clearDraft,
  loadDraft,
  saveDraft,
} from "./draftStorage";

beforeEach(() => {
  localStorage.clear();
});

describe("saveDraft + loadDraft round-trip", () => {
  it("stores content that survives a fresh load call", () => {
    saveDraft("channel", "ch-1", "hello world");
    expect(loadDraft("channel", "ch-1")).toBe("hello world");
  });

  it("returns empty string when nothing is stored", () => {
    expect(loadDraft("channel", "ch-1")).toBe("");
  });

  it("keeps channel and dm scopes disjoint", () => {
    // A user sharing a channelId between a server channel and a DM
    // (unlikely but not architecturally forbidden) must not see their
    // channel draft when opening the DM.
    saveDraft("channel", "shared-id", "channel note");
    saveDraft("dm", "shared-id", "dm note");
    expect(loadDraft("channel", "shared-id")).toBe("channel note");
    expect(loadDraft("dm", "shared-id")).toBe("dm note");
  });

  it("empty channelId is a no-op — save/load/clear all return safely", () => {
    saveDraft("channel", "", "should not persist");
    expect(loadDraft("channel", "")).toBe("");
    clearDraft("channel", ""); // must not throw
  });
});

describe("saveDraft — whitespace + boundary handling", () => {
  it("empty content clears the draft rather than storing a blank", () => {
    // Symmetry pin: user typed "hello", then deleted every character.
    // The composer would call saveDraft("") — persisting a blank
    // string would leave a "0-length message pending" phantom in dev-
    // tools that looks like a bug. Treat empty as "no draft".
    saveDraft("channel", "ch-1", "hello");
    saveDraft("channel", "ch-1", "");
    expect(loadDraft("channel", "ch-1")).toBe("");
  });

  it("whitespace-only content clears the draft", () => {
    saveDraft("channel", "ch-1", "hi");
    saveDraft("channel", "ch-1", "   \n\t   ");
    expect(loadDraft("channel", "ch-1")).toBe("");
  });

  it("caps very long input at MAX_DRAFT_CHARS on write", () => {
    // Paste-a-book edge case. Composer's send-time cap is smaller
    // (MAX_MESSAGE_LENGTH); the draft cap is a bit more generous so
    // the user can trim down without losing the whole paste.
    const oversized = "a".repeat(MAX_DRAFT_CHARS + 500);
    saveDraft("channel", "ch-1", oversized);
    const got = loadDraft("channel", "ch-1");
    expect(got.length).toBe(MAX_DRAFT_CHARS);
    // Prefix, not suffix — a truncated tail is the expected shape.
    expect(got).toBe("a".repeat(MAX_DRAFT_CHARS));
  });

  it("also truncates on READ so a hand-edited oversized entry can't leak past the cap", () => {
    // Belt-and-braces: someone flipping bits in dev-tools or an
    // orphaned pre-cap entry from a legacy build shouldn't hand a
    // caller a 10MB string that then blows out the composer.
    const raw = "x".repeat(MAX_DRAFT_CHARS + 100);
    localStorage.setItem("mqvi_draft:channel:ch-1", raw);
    expect(loadDraft("channel", "ch-1").length).toBe(MAX_DRAFT_CHARS);
  });
});

describe("clearDraft", () => {
  it("removes the entry", () => {
    saveDraft("channel", "ch-1", "temporary");
    clearDraft("channel", "ch-1");
    expect(loadDraft("channel", "ch-1")).toBe("");
  });

  it("is idempotent — safe to call when no draft exists", () => {
    // Composer will call this on every successful send, including the
    // first send in a fresh channel.
    clearDraft("channel", "never-existed");
    // No assertion beyond "did not throw" — reaching this line is
    // the whole test.
  });
});

describe("clearAllDrafts", () => {
  it("wipes every draft across scopes and channels", () => {
    saveDraft("channel", "ch-1", "one");
    saveDraft("channel", "ch-2", "two");
    saveDraft("dm", "user-1", "three");
    clearAllDrafts();
    expect(loadDraft("channel", "ch-1")).toBe("");
    expect(loadDraft("channel", "ch-2")).toBe("");
    expect(loadDraft("dm", "user-1")).toBe("");
  });

  it("leaves non-draft localStorage keys untouched", () => {
    // The auth store and other Zustand-persist slices live in the same
    // localStorage. Wiping "everything with our prefix" must not take
    // out unrelated keys — a logout that also deleted app settings
    // would surprise the user.
    localStorage.setItem("auth-store", "important");
    localStorage.setItem("mqvi_draft:channel:ch-1", "temp");
    clearAllDrafts();
    expect(localStorage.getItem("auth-store")).toBe("important");
    expect(localStorage.getItem("mqvi_draft:channel:ch-1")).toBeNull();
  });
});

describe("localStorage failure modes", () => {
  const originalSet = localStorage.setItem;
  const originalGet = localStorage.getItem;

  afterEach(() => {
    localStorage.setItem = originalSet;
    localStorage.getItem = originalGet;
  });

  it("saveDraft swallows setItem exceptions (quota / private mode)", () => {
    // iOS Safari in private mode throws QuotaExceededError on every
    // set. A crash there would take out the composer for zero UX gain.
    localStorage.setItem = vi.fn(() => {
      throw new Error("QuotaExceededError");
    });
    // The call itself must not throw. Reaching this line is the pin.
    saveDraft("channel", "ch-1", "hello");
  });

  it("loadDraft swallows getItem exceptions and returns empty string", () => {
    localStorage.getItem = vi.fn(() => {
      throw new Error("SecurityError");
    });
    expect(loadDraft("channel", "ch-1")).toBe("");
  });
});
