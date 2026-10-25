import { describe, expect, it } from "vitest";
import type { AppNotification } from "../types/notification";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "./notificationPreferences";
import { projectOverlayNotifications } from "./overlayNotifications";

const notification = (partial: Partial<AppNotification> = {}): AppNotification => ({
  id: "n1", user_id: "owner", kind: "mention", actor_id: "actor", actor: null,
  server_id: null, channel_id: null, dm_channel_id: null, message_id: null,
  read_at: null, created_at: "2026-10-25T00:00:00Z", payload: { preview: "private" }, ...partial,
});
const project = (items: AppNotification[], extra = {}) => projectOverlayNotifications({
  ownerId: "owner", currentOwnerId: "owner", authGeneration: 2, currentAuthGeneration: 2,
  status: "online", items, preferences: DEFAULT_NOTIFICATION_PREFERENCES,
  isVisible: () => true, ...extra,
});

describe("overlay notification metadata", () => {
  it("projects only bounded metadata and deduplicates real unread rows", () => {
    expect(project([notification(), notification(), ...[2, 3, 4].map((i) => notification({ id: `n${i}` }))]))
      .toEqual([1, 2, 3].map((i) => ({ id: `n${i}`, category: "mention" })));
  });
  it("rejects stale owners, sessions, read, self and inaccessible notifications", () => {
    expect(project([notification()], { currentOwnerId: "other" })).toEqual([]);
    expect(project([notification()], { currentAuthGeneration: 3 })).toEqual([]);
    expect(project([notification({ user_id: "other" }), notification({ read_at: "now" }), notification({ actor_id: "owner" })])).toEqual([]);
    expect(project([notification()], { isVisible: () => false })).toEqual([]);
    for (const status of ["dnd", "offline", "invisible"]) expect(project([notification()], { status })).toEqual([]);
  });
  it("respects reaction scopes, category optouts and fails closed for unknown events", () => {
    const reaction = notification({ kind: "system", payload: { subtype: "reaction" } });
    expect(project([reaction])).toEqual([]);
    expect(project([{ ...reaction, dm_channel_id: "dm" }])).toEqual([{ id: "n1", category: "system" }]);
    expect(project([notification({ kind: "system", payload: { action: "stream_start" } })], {
      preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, streamNotifications: false },
    })).toEqual([]);
    expect(project([notification({ kind: "system", payload: { action: "unknown" } })])).toEqual([]);
  });
  it("rejects unsafe ids without forwarding arbitrary payload properties", () => {
    expect(project([notification({ id: "x\n" }), notification({ id: "a".repeat(129) })])).toEqual([]);
    expect(Object.keys(project([notification()])[0])).toEqual(["id", "category"]);
  });
  it("applies online and upcoming-event opt-outs to typed and legacy persisted notices", () => {
    const onlinePayloads = [{ action: "friend_online" }, { title: "Friend is online", body: "Private actor name" }];
    for (const payload of onlinePayloads) {
      const n = notification({ kind: "system", payload });
      expect(project([n])).toEqual([]);
      expect(project([n], { preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, onlineFriendNotifications: true } }))
        .toEqual([{ id: "n1", category: "system" }]);
    }
    for (const payload of [{ action: "server_event_upcoming", event_id: "event" }, { event_id: "event", title: "Private event" }]) {
      const n = notification({ kind: "system", payload });
      expect(project([n])).toEqual([{ id: "n1", category: "system" }]);
      expect(project([n], { preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, upcomingEventNotifications: false } })).toEqual([]);
    }
  });
});
