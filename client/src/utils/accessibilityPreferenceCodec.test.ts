import { expect, it, vi } from "vitest";
import { sanitizeAccessibilityPreferences } from "./accessibilityPreferenceCodec";

it("retains the exact validated value when an input accessor changes on its next read", () => {
  const read = vi.fn().mockReturnValueOnce(18).mockReturnValue(400);
  const input = Object.defineProperty({}, "chatFontSize", { enumerable: true, get: read });
  expect(sanitizeAccessibilityPreferences(input)).toEqual({ chatFontSize: 18 });
  expect(read).toHaveBeenCalledOnce();
});
