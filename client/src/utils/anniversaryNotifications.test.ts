import { expect, it } from "vitest";
import { shouldCueAnniversary } from "./anniversaryNotifications";
import { DEFAULT_NOTIFICATION_PREFERENCES as prefs } from "./notificationPreferences";
import type { AppNotification } from "../types";

const n: AppNotification = { id: "a", user_id: "me", kind: "system", actor_id: "friend", actor: null, server_id: null, channel_id: null, message_id: null, dm_channel_id: null, payload: { action: "friend_anniversary", years: 1 }, read_at: null, created_at: "2026-10-24T00:00:00Z" };
it("cues an eligible background anniversary only", () => {
  expect(shouldCueAnniversary(n, prefs, "me", "online", false)).toBe(true);
  expect(shouldCueAnniversary(n, prefs, "me", "online", true)).toBe(false);
  expect(shouldCueAnniversary(n, { ...prefs, notifyWhenFocused: true }, "me", "online", true)).toBe(true);
});
it("honors recipient, read state, status and preference", () => {
  for (const item of [{ ...n, user_id: "other" }, { ...n, actor_id: "me" }, { ...n, actor_id: null }, { ...n, read_at: "read" }]) {
    expect(shouldCueAnniversary(item, prefs, "me", "online", false)).toBe(false);
  }
  for (const status of ["dnd", "offline"]) expect(shouldCueAnniversary(n, prefs, "me", status, false)).toBe(false);
  expect(shouldCueAnniversary(n, { ...prefs, friendAnniversaryNotifications: false }, "me", "online", false)).toBe(false);
});
it.each([0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1])("does not cue invalid year %s", (years) => {
  expect(shouldCueAnniversary({ ...n, payload: { action: "friend_anniversary", years } }, prefs, "me", "online", false)).toBe(false);
});
