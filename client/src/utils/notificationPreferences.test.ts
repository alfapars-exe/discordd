import { beforeEach, describe, expect, it } from "vitest";
import { usePreferencesStore } from "../stores/preferencesStore";
import { getNotificationPreferences, shouldFlashTaskbar } from "./notificationPreferences";

describe("notification preferences", () => {
  beforeEach(() => usePreferencesStore.getState().reset());

  it("uses safe defaults when the account has no stored choices", () => {
    expect(getNotificationPreferences().desktopEnabled).toBe(true);
    expect(getNotificationPreferences().reactionMode).toBe("direct");
    expect(getNotificationPreferences().upcomingEventNotifications).toBe(true);
    expect(shouldFlashTaskbar()).toBe(true);
  });

  it("applies account choices to attention behavior", () => {
    usePreferencesStore.setState({ data: { notifications: { taskbarFlash: false, muteAllSounds: false } } });
    expect(shouldFlashTaskbar()).toBe(false);
    usePreferencesStore.setState({ data: { notifications: { taskbarFlash: true, muteAllSounds: true } } });
    expect(shouldFlashTaskbar()).toBe(true);
  });
  it("retains the upcoming event notification opt-out", () => {
    usePreferencesStore.setState({data:{notifications:{upcomingEventNotifications:false}}});
    expect(getNotificationPreferences().upcomingEventNotifications).toBe(false);
  });
});
