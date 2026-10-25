import type { AppNotification } from "../types";
import type { NotificationPreferences } from "./notificationPreferences";

type Destination = { type: string; channelId?: string } | undefined;

export function shouldCueReaction(n: AppNotification, preferences: NotificationPreferences, userId: string | undefined, status: string | undefined, destination: Destination, focused: boolean): boolean {
  if (n.kind !== "system" || n.payload.subtype !== "reaction" || n.read_at || n.user_id !== userId || n.actor_id === userId) return false;
  if (status === "dnd" || status === "offline" || preferences.reactionMode === "none") return false;
  const groupId = typeof n.payload.group_id === "string" ? n.payload.group_id : undefined;
  if (preferences.reactionMode === "direct" && !n.dm_channel_id && !groupId) return false;
  const viewing = destination && (
    (destination.type === "text" && destination.channelId === n.channel_id) ||
    (destination.type === "dm" && destination.channelId === n.dm_channel_id) ||
    (destination.type === "group-dm" && destination.channelId === groupId)
  );
  return !(focused && viewing) || preferences.currentChannelSound;
}
