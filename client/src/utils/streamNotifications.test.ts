import { expect, it } from "vitest";
import { shouldCueStream } from "./streamNotifications";
import { DEFAULT_NOTIFICATION_PREFERENCES as prefs } from "./notificationPreferences";
import type { AppNotification } from "../types";

const n: AppNotification = { id: "stream", user_id: "me", kind: "system", actor_id: "friend", actor: null, server_id: null, channel_id: null, message_id: null, dm_channel_id: null, payload: { action: "stream_start" }, read_at: null, created_at: "2026-10-24T00:00:00Z" };
it("cues allowed background streams but honors focus", () => {
  expect(shouldCueStream(n, prefs, "me", "online", false)).toBe(true);
  expect(shouldCueStream(n, prefs, "me", "online", true)).toBe(false);
  expect(shouldCueStream(n, { ...prefs, notifyWhenFocused: true }, "me", "online", true)).toBe(true);
});
it("rejects wrong recipients, unrelated events, read notices and self events", () => {
  for (const item of [{ ...n, user_id: "other" }, { ...n, actor_id: "me" }, { ...n, actor_id: null }, { ...n, read_at: "read" }, { ...n, payload: { action: "other" } }]) {
    expect(shouldCueStream(item, prefs, "me", "online", false)).toBe(false);
  }
});
it("honors stream preference and DND/invisible", () => {
  expect(shouldCueStream(n, { ...prefs, streamNotifications: false }, "me", "online", false)).toBe(false);
  for (const status of ["dnd", "offline"]) expect(shouldCueStream(n, prefs, "me", status, false)).toBe(false);
});
