import { describe, it, expect, beforeAll, afterAll } from "vitest";
import i18n from "./index";

// Guards i18next's plural resolution for the last-seen labels, which mix two
// valid strategies across languages:
//   - EN needs distinct forms ("1 hour ago" vs "5 hours ago"), so
//     en/common.json has lastSeenHours_one / lastSeenHours_other.
//   - TR does not inflect a noun after a number ("3 saat", never "3 saatler"),
//     so tr/common.json intentionally carries a single un-suffixed
//     lastSeenHours. i18next 26 (v4 plural format) falls a missing plural key
//     back to the base key, so this resolves correctly even though fallbackLng
//     is "tr" (there is no EN fallback for a TR user).
// This was once flagged as a "missing TR plural suffix" bug; it is not — adding
// _one/_other to TR would produce incorrect Turkish. The test locks in the
// correct behavior so neither an "obvious fix" nor an i18next upgrade silently
// regresses it. See utils/dateFormat.ts:lastSeenLabel + MemberItem.tsx.
describe("lastSeenHours plural resolution", () => {
  const original = i18n.language;

  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });

  afterAll(async () => {
    await i18n.changeLanguage(original);
  });

  it("resolves TR via the un-suffixed base key for any count", () => {
    expect(i18n.t("lastSeenHours", { count: 1 })).toBe("1 saat önce");
    expect(i18n.t("lastSeenHours", { count: 3 })).toBe("3 saat önce");
  });

  it("resolves EN via _one / _other plural suffixes", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("lastSeenHours", { count: 1 })).toBe("1 hour ago");
    expect(i18n.t("lastSeenHours", { count: 5 })).toBe("5 hours ago");
    await i18n.changeLanguage("tr");
  });
});
