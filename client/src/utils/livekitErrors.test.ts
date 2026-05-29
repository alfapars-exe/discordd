/**
 * isHarmlessVoiceRace regression tests — this guard decides which LiveKit
 * errors get swallowed as engine-teardown noise vs surfaced as real failures,
 * so its match conditions must stay exactly as intended (two message
 * substrings + two error class names).
 */

import { describe, it, expect } from "vitest";
import { isHarmlessVoiceRace } from "./livekitErrors";

describe("isHarmlessVoiceRace", () => {
  it('matches the "engine not connected" message (case-insensitive)', () => {
    expect(isHarmlessVoiceRace(new Error("Engine not connected within timeout"))).toBe(true);
  });

  it('matches the "client initiated disconnect" message', () => {
    expect(isHarmlessVoiceRace(new Error("Client initiated disconnect"))).toBe(true);
  });

  it("matches by error class name PublishTrackError", () => {
    const err = new Error("publishing rejected");
    err.name = "PublishTrackError";
    expect(isHarmlessVoiceRace(err)).toBe(true);
  });

  it("matches by error class name ConnectionError", () => {
    const err = new Error("something");
    err.name = "ConnectionError";
    expect(isHarmlessVoiceRace(err)).toBe(true);
  });

  it("returns false for an ordinary error", () => {
    expect(isHarmlessVoiceRace(new Error("real failure: permission denied"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isHarmlessVoiceRace("engine not connected")).toBe(false);
    expect(isHarmlessVoiceRace(null)).toBe(false);
    expect(isHarmlessVoiceRace(undefined)).toBe(false);
  });
});
