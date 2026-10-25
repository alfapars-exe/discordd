import { describe, expect, it } from "vitest";
import { formatNotificationBadge } from "./useNotificationBadge";

describe("formatNotificationBadge", () => {
  it("formats positive counts as compact plus badges", () => {
    expect(formatNotificationBadge(1)).toBe("1+");
    expect(formatNotificationBadge(2)).toBe("2+");
    expect(formatNotificationBadge(9)).toBe("9+");
  });

  it("caps counts above nine at 9+", () => {
    expect(formatNotificationBadge(10)).toBe("9+");
    expect(formatNotificationBadge(999)).toBe("9+");
  });

  it("normalizes invalid numeric values safely", () => {
    expect(formatNotificationBadge(0)).toBe("0+");
    expect(formatNotificationBadge(-3)).toBe("0+");
    expect(formatNotificationBadge(2.9)).toBe("2+");
  });
});
