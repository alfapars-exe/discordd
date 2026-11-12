import { describe, expect, it } from "vitest";
import { APPEARANCE_DEFAULTS, APPEARANCE_RANGES } from "./appearancePreferences";
import { cacheable, decodeLegacyAppearance } from "./preferencesCodec";

describe("account appearance cache", () => {
  it("round-trips all default fields through legacy storage and the account cache", () => {
    const appearance = Object.fromEntries(Object.entries(APPEARANCE_DEFAULTS).map(([key, value]) => {
      const stored = typeof value === "boolean" ? String(Number(value)) : String(value);
      return [key, decodeLegacyAppearance(key, stored)];
    }));
    expect(cacheable({ appearance: { ...appearance, unknownField: true } })).toEqual({ appearance: APPEARANCE_DEFAULTS });
  });

  it.each(Object.entries(APPEARANCE_RANGES))("preserves both boundaries for %s", (field, [min, max]) => {
    for (const value of [min, max]) {
      expect(cacheable({ appearance: { [field]: value } })).toEqual({ appearance: { [field]: value } });
    }
    for (const value of [min - 1, max + 1]) {
      expect(cacheable({ appearance: { [field]: value } })).toEqual({});
    }
  });
});
