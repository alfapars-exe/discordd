import type { AppNotification } from "../types/notification";
import type { NotificationPreferences } from "./notificationPreferences";
import { isChannelMessageNotification, isPrivateMessageNotification } from "./dmMessageNotification";

export type OverlayNotification = { id: string; category: "mention" | "reply" | "friend_request" | "dm_request" | "system" | "message" };

/** Metadata only: decrypted previews, actors and payloads never cross the overlay bridge. */
export function projectOverlayNotifications(input: {
  ownerId: string | null; currentOwnerId: string | null;
  authGeneration: number; currentAuthGeneration: number;
  status: string; items: readonly AppNotification[];
  preferences: NotificationPreferences;
  isVisible: (notification: AppNotification) => boolean;
}): OverlayNotification[] {
  if (!input.ownerId || input.ownerId !== input.currentOwnerId
    || input.authGeneration !== input.currentAuthGeneration
    || input.status === "dnd" || input.status === "offline" || input.status === "invisible") return [];
  const seen = new Set<string>();
  const result: OverlayNotification[] = [];
  for (const n of input.items) {
    if (result.length === 3) break;
    if (n.user_id !== input.ownerId || n.read_at || n.actor_id === input.ownerId
      || typeof n.id !== "string" || !n.id || n.id.length > 128 || Array.from(n.id).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      || seen.has(n.id) || !input.isVisible(n)) continue;
    if (!["mention", "reply", "friend_request", "dm_request", "system"].includes(n.kind)) continue;
    if (n.kind === "system") {
      const p = input.preferences;
      // Older servers persisted event/online notices without an action key.
      // Apply current opt-outs to those historical rows as well.
      if (typeof n.payload.event_id === "string" && !p.upcomingEventNotifications) continue;
      if (n.payload.title === "Friend is online" && !p.onlineFriendNotifications) continue;
      if (n.payload.subtype === "reaction") {
        if (p.reactionMode === "none" || (p.reactionMode === "direct" && !n.dm_channel_id && typeof n.payload.group_id !== "string")) continue;
      } else if (typeof n.payload.subtype === "string") continue;
      const action = n.payload.action;
      if (typeof action === "string") {
        const allowed: Record<string, boolean> = {
          stream_start: p.streamNotifications,
          friend_anniversary: p.friendAnniversaryNotifications,
          profile_update: p.profileUpdateNotifications,
          friend_online: p.onlineFriendNotifications,
          server_event_upcoming: p.upcomingEventNotifications,
          incoming_message: isPrivateMessageNotification(n) || (isChannelMessageNotification(n) && p.channelMessageNotifications),
        };
        // Unknown event categories fail closed until their preference is mapped.
        if (allowed[action] !== true) continue;
      }
    }
    seen.add(n.id);
    result.push({ id: n.id, category: isPrivateMessageNotification(n) || isChannelMessageNotification(n) ? "message" : n.kind });
  }
  return result;
}
