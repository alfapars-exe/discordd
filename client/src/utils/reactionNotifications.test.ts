import { describe, expect, it } from "vitest";
import { shouldCueReaction } from "./reactionNotifications";
import { DEFAULT_NOTIFICATION_PREFERENCES as defaults } from "./notificationPreferences";
import type { AppNotification } from "../types";

const notification: AppNotification = {
  id: "reaction-1", user_id: "me", actor_id: "other", actor: null, kind: "system",
  server_id: "server", channel_id: "channel", message_id: "message", dm_channel_id: null,
  payload: { subtype: "reaction", emoji: "👍" }, read_at: null, created_at: "2026-10-24T00:00:00Z",
};

describe("reaction attention policy", () => {
  it("limits private mode to DM and group origins", () => {
    expect(shouldCueReaction(notification, defaults, "me", "online", undefined, false)).toBe(false);
    expect(shouldCueReaction({ ...notification, dm_channel_id: "private" }, defaults, "me", "online", undefined, false)).toBe(true);
    expect(shouldCueReaction({ ...notification, payload: { subtype: "reaction", group_id: "group" } }, defaults, "me", "online", undefined, false)).toBe(true);
    expect(shouldCueReaction(notification, { ...defaults, reactionMode: "all" }, "me", "online", undefined, false)).toBe(true);
  });
  it("suppresses self, foreign-account, read and quiet events", () => {
    const prefs = { ...defaults, reactionMode: "all" as const };
    for (const n of [{ ...notification, actor_id: "me" }, { ...notification, user_id: "someone" }, { ...notification, read_at: "read" }]) {
      expect(shouldCueReaction(n, prefs, "me", "online", undefined, false)).toBe(false);
    }
    for (const status of ["dnd", "offline"]) expect(shouldCueReaction(notification, prefs, "me", status, undefined, false)).toBe(false);
    expect(shouldCueReaction(notification, { ...prefs, reactionMode: "none" }, "me", "online", undefined, false)).toBe(false);
  });
  it("respects current-conversation sound only while focused", () => {
    const prefs = { ...defaults, reactionMode: "all" as const };
    const destination = { type: "text", channelId: "channel" };
    expect(shouldCueReaction(notification, prefs, "me", "online", destination, true)).toBe(false);
    expect(shouldCueReaction(notification, prefs, "me", "online", destination, false)).toBe(true);
    expect(shouldCueReaction(notification, { ...prefs, currentChannelSound: true }, "me", "online", destination, true)).toBe(true);
  });
});
