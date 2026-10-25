import { describe, expect, it } from "vitest";
import { newPasswordError } from "./passwordPolicy";

describe("new password policy", () => {
  it("counts Unicode characters, not UTF-16 code units or UTF-8 bytes", () => {
    expect(newPasswordError("😀".repeat(4))).toBe("passwordTooShort");
    expect(newPasswordError("ş".repeat(7))).toBe("passwordTooShort");
    expect(newPasswordError("😀".repeat(8))).toBeNull();
  });
  it("rejects bcrypt overflow before a request, without trimming passwords", () => {
    expect(newPasswordError("a".repeat(72))).toBeNull();
    expect(newPasswordError("a".repeat(73))).toBe("passwordTooLong");
    expect(newPasswordError("😀".repeat(18))).toBeNull();
    expect(newPasswordError("😀".repeat(19))).toBe("passwordTooLong");
    expect(newPasswordError("        ")).toBeNull();
  });
});
