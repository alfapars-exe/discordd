/**
 * returnUrl helpers — `?returnUrl=` is attacker-controlled query input, so
 * these tests pin the open-redirect defenses (sanitizeReturnUrl) and the
 * exact-match invite-path detection used to auto-join after registration
 * (matchInviteReturnUrl).
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_RETURN_PATH, sanitizeReturnUrl, matchInviteReturnUrl } from "./returnUrl";

describe("sanitizeReturnUrl", () => {
  it("passes through a safe in-app path", () => {
    expect(sanitizeReturnUrl("/invite/0123456789abcdef")).toBe("/invite/0123456789abcdef");
    expect(sanitizeReturnUrl("/channels/srv1")).toBe("/channels/srv1");
  });

  it("falls back to the default for missing input", () => {
    expect(sanitizeReturnUrl(null)).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl(undefined)).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("")).toBe(DEFAULT_RETURN_PATH);
  });

  it("rejects protocol-relative URLs (open redirect via //)", () => {
    expect(sanitizeReturnUrl("//evil.example")).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("//evil.example/phish")).toBe(DEFAULT_RETURN_PATH);
  });

  it("rejects absolute URLs with a scheme", () => {
    expect(sanitizeReturnUrl("https://evil.example")).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("http://evil.example")).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("javascript:alert(1)")).toBe(DEFAULT_RETURN_PATH);
  });

  it("rejects paths that don't start with a single slash", () => {
    expect(sanitizeReturnUrl("channels")).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("evil.example/channels")).toBe(DEFAULT_RETURN_PATH);
  });

  // Regression: a startsWith("//") check let these through. The URL parser
  // treats backslash as a slash, and strips TAB/LF/CR before parsing, so each
  // of these resolves to the protocol-relative //evil.example.
  it("rejects backslash-smuggled protocol-relative URLs", () => {
    expect(sanitizeReturnUrl("/\\evil.example")).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("/\\evil.example/phish")).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("\\\\evil.example")).toBe(DEFAULT_RETURN_PATH);
  });

  it("rejects control-character-smuggled protocol-relative URLs", () => {
    // searchParams.get() has already decoded %09/%0a/%0d into raw control
    // characters by the time sanitizeReturnUrl sees the value.
    expect(sanitizeReturnUrl("/\t/evil.example")).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("/\n/evil.example")).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("/\r/evil.example")).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("/\t\\evil.example")).toBe(DEFAULT_RETURN_PATH);
  });

  // Regression: an origin check alone is not enough. Dot-segment
  // normalisation yields a pathname starting with "//" while the URL's origin
  // stays same-origin, so serialising the path back out re-creates a
  // protocol-relative URL.
  it("rejects dot-segment paths that normalise to protocol-relative", () => {
    expect(sanitizeReturnUrl("/..//evil.example")).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("/.//evil.example")).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("/a/..//evil.example")).toBe(DEFAULT_RETURN_PATH);
    expect(sanitizeReturnUrl("/a/b/../..//evil.example")).toBe(DEFAULT_RETURN_PATH);
  });

  it("still allows single-slash dot-segment paths", () => {
    // "/../evil.example" normalises to "/evil.example" — same origin, one
    // slash, genuinely in-app. Not collateral damage from the guard above.
    expect(sanitizeReturnUrl("/../evil.example")).toBe("/evil.example");
  });

  it("preserves query and hash on same-origin paths", () => {
    expect(sanitizeReturnUrl("/channels/srv1?tab=2")).toBe("/channels/srv1?tab=2");
    expect(sanitizeReturnUrl("/channels/srv1#top")).toBe("/channels/srv1#top");
  });
});

describe("matchInviteReturnUrl", () => {
  it("captures the invite code on an exact match", () => {
    expect(matchInviteReturnUrl("/invite/0123456789abcdef")).toBe("0123456789abcdef");
  });

  it("returns null for missing input", () => {
    expect(matchInviteReturnUrl(null)).toBeNull();
    expect(matchInviteReturnUrl(undefined)).toBeNull();
  });

  it("returns null for non-invite paths", () => {
    expect(matchInviteReturnUrl("/channels")).toBeNull();
    expect(matchInviteReturnUrl("//evil.example")).toBeNull();
    expect(matchInviteReturnUrl("https://evil.example")).toBeNull();
  });

  it("rejects loose prefix matches (trailing segments, wrong length)", () => {
    expect(matchInviteReturnUrl("/invite/0123456789abcdef/extra")).toBeNull();
    expect(matchInviteReturnUrl("/invite/0123456789abcde")).toBeNull(); // 15 chars
    expect(matchInviteReturnUrl("/invite/0123456789abcdef0")).toBeNull(); // 17 chars
  });

  it("rejects uppercase or non-hex characters", () => {
    expect(matchInviteReturnUrl("/invite/0123456789ABCDEF")).toBeNull();
    expect(matchInviteReturnUrl("/invite/gggggggggggggggg")).toBeNull();
  });
});
