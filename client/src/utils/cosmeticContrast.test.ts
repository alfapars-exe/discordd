import { describe, it, expect } from "vitest";
import { contrastRatio, nameStyleReadable } from "./cosmeticContrast";

// Sözleşme §4 vectors — identical to Go models/cosmetic_contrast_test.go.
describe("contrastRatio", () => {
  it("white on the reference background ≈ 10.06", () => {
    expect(Math.abs(contrastRatio("#ffffff", "#3b4252") - 10.06)).toBeLessThanOrEqual(0.01);
  });

  it("#b0b0b0 ≈ 4.64 and #a0a0a0 ≈ 3.85", () => {
    expect(contrastRatio("#b0b0b0", "#3b4252")).toBeCloseTo(4.64, 1);
    expect(contrastRatio("#a0a0a0", "#3b4252")).toBeCloseTo(3.85, 1);
  });

  it("is symmetric and 1 for invalid input", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#000000"), 10);
    expect(contrastRatio("red", "#ffffff")).toBe(1);
  });
});

describe("nameStyleReadable", () => {
  const passing: string[][] = [
    ["#ffffff"],
    ["#b0b0b0"],
    ["#ffd166", "#ffb703"],
    ["#a8e6ff", "#e0f7ff"],
    // every built-in b_name_* seed (migration 089)
    ["#ffb3c6", "#ffd6e0"],
    ["#b8f2d0", "#7ee0b0"],
    ["#d7b8ff", "#b8c6ff"],
    ["#b8ffb8"],
  ];
  const failing: string[][] = [["#a0a0a0"], ["#808080"], ["#3b4252"], ["#ffffff", "#000000"]];

  for (const stops of passing) {
    it(`passes ${stops.join(" → ")}`, () => expect(nameStyleReadable(stops)).toBe(true));
  }
  for (const stops of failing) {
    it(`fails ${stops.join(" → ")}`, () => expect(nameStyleReadable(stops)).toBe(false));
  }

  it("a light theme background fails even a seed that passes on dark", () => {
    expect(nameStyleReadable(["#ffd166", "#ffb703"], "#ffffff")).toBe(false);
  });

  it("rejects 0 or 3 stops and invalid hex", () => {
    expect(nameStyleReadable([])).toBe(false);
    expect(nameStyleReadable(["#ffffff", "#ffffff", "#ffffff"])).toBe(false);
    expect(nameStyleReadable(["#fff"])).toBe(false);
  });
});
