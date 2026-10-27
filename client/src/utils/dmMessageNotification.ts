import type { AppNotification } from "../types/notification";

/** Existing system kind, explicit source; never interpret a DM request as a message. */
export function isDMMessageNotification(n: AppNotification): boolean {
  return n.kind === "system" && n.payload.action === "incoming_message" && n.payload.source === "dm"
    && typeof n.dm_channel_id === "string" && !!n.dm_channel_id && typeof n.message_id === "string" && !!n.message_id
    && !!n.actor_id && !n.group_dm_channel_id && !n.server_id && !n.channel_id && n.payload.group_id === undefined;
}

/** Metadata-only persisted group source; legacy payload.group_id is not this contract. */
export function isGroupMessageNotification(n: AppNotification): boolean {
  return n.kind === "system" && n.payload.action === "incoming_message" && n.payload.source === "group"
    && Object.keys(n.payload).length === 2 && typeof n.group_dm_channel_id === "string" && !!n.group_dm_channel_id
    && typeof n.message_id === "string" && !!n.message_id && !!n.actor_id
    && !n.server_id && !n.channel_id && !n.dm_channel_id;
}
/** Strict metadata-only server channel source. */
export function isChannelMessageNotification(n: AppNotification): boolean {
  return n.kind === "system" && n.payload.action === "incoming_message" && n.payload.source === "channel"
    && Object.keys(n.payload).length === 2 && typeof n.server_id === "string" && !!n.server_id
    && typeof n.channel_id === "string" && !!n.channel_id && typeof n.message_id === "string" && !!n.message_id
    && typeof n.actor_id === "string" && !!n.actor_id && !n.dm_channel_id && !n.group_dm_channel_id;
}
export const isPrivateMessageNotification = (n: AppNotification) => isDMMessageNotification(n) || isGroupMessageNotification(n);
