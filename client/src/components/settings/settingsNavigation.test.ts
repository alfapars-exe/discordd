import { describe, expect, it } from "vitest";
import { getSettingsGroups } from "./settingsNavigation";
import { Permissions } from "../../utils/permissions";

describe("contextual settings destinations", () => {
  it("keeps server and platform management out of account settings even for admins", () => {
    const items = getSettingsGroups(Permissions.Admin, true, true, "account").flatMap((group) => group.items.map((item) => item.id));
    expect(items).toContain("profile");
    expect(items).toContain("voice");
    expect(items).not.toContain("server-general");
    expect(items).not.toContain("platform-users");
  });
  it("retains the special entrance-sound gate without granting other server editors", () => {
    const items = getSettingsGroups(Permissions.MuteMembers, false, false, "server").flatMap((group) => group.items.map((item) => item.id));
    expect(items).toEqual(["entrance-sounds"]);
    expect(getSettingsGroups(0, false, false, "server")[0].items).toEqual([]);
  });
  it("hides platform destinations when admin access is lost and desktop connections on web", () => {
    expect(getSettingsGroups(0, false, true, "platform")[0].items).toEqual([]);
    const platformItems = getSettingsGroups(0, true, false, "platform")[0].items.map((item) => item.id);
    expect(platformItems).toContain("platform-campaigns");
    expect(platformItems).not.toContain("platform-connections");
  });

  it("keeps registered games in a separate settings group on desktop and web", () => {
    for (const desktop of [true, false]) {
      const groups = getSettingsGroups(0, false, desktop, "account");
      const games = groups.find((group) => group.label === "gamesGroup");
      expect(games?.items).toEqual([
        { id: "activity-privacy", labelKey: "activityPrivacyTitle" },
        { id: "registered-games", labelKey: "registeredGamesTitle" },
      ]);
      expect(groups.find((group) => group.label === "experienceGroup")?.items.some((item) => item.id === "registered-games")).toBe(false);
    }
  });
});
