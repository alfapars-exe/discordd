import type { AppNotification } from "../types/notification";

/** Existing system kind, explicit source; never interpret a DM request as a message. */
export function isDMMessageNotification(n: AppNotification): boolean {
  return n.kind === "system" && n.payload.action === "incoming_message" && n.payload.source === "dm"
    && typeof n.dm_channel_id === "string" && !!n.dm_channel_id && typeof n.message_id === "string" && !!n.message_id
    && !!n.actor_id && !n.server_id && !n.channel_id && n.payload.group_id === undefined;
}
