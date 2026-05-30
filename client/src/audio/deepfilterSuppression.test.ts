import { describe, it, expect } from "vitest";
import { strengthToAttenLimDb } from "./deepfilterSuppression";

describe("strengthToAttenLimDb", () => {
  it("maps the endpoints to upstream's special values", () => {
    expect(strengthToAttenLimDb(0)).toBe(0); // passthrough
    expect(strengthToAttenLimDb(100)).toBe(100); // None = full suppression
  });

  it("maps strength% to the perceptual mix domain (1 - floor = % denoised)", () => {
    // db = -20·log10(1 - s/100), rounded to int dB.
    expect(strengthToAttenLimDb(50)).toBe(6); // floor 0.5  → 6.02 dB
    expect(strengthToAttenLimDb(70)).toBe(10); // floor 0.3  → 10.46 dB
    expect(strengthToAttenLimDb(90)).toBe(20); // floor 0.1  → 20 dB
    expect(strengthToAttenLimDb(99)).toBe(40); // floor 0.01 → 40 dB
  });

  it("is monotonically non-decreasing across the range", () => {
    let prev = -1;
    for (let s = 0; s <= 100; s++) {
      const db = strengthToAttenLimDb(s);
      expect(db).toBeGreaterThanOrEqual(prev);
      prev = db;
    }
  });

  it("clamps out-of-range input and never exceeds [0, 100]", () => {
    expect(strengthToAttenLimDb(-20)).toBe(0);
    expect(strengthToAttenLimDb(150)).toBe(100);
    expect(strengthToAttenLimDb(73.4)).toBeGreaterThanOrEqual(0);
    expect(strengthToAttenLimDb(73.4)).toBeLessThanOrEqual(100);
  });

  it("never returns the broken identity mapping (regression: % was passed as dB)", () => {
    // The old bug fed the slider value straight in as dB, so 50 → 50 dB
    // (≈full suppression). The mapping must compress the mid-range.
    expect(strengthToAttenLimDb(50)).toBeLessThan(50);
    expect(strengthToAttenLimDb(40)).toBeLessThan(40);
  });
});
