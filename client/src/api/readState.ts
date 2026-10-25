/**
 * Read State API — unread message tracking, server-scoped.
 */

import { apiClient } from "./client";

export type UnreadInfo = {
  channel_id: string;
  unread_count: number;
  /** Authoritative persisted direct/current-role mentions after the read cursor. */
  mention_count?: number;
  /** Opaque authorized anchor; no message body is returned by this endpoint. */
  oldest_unread_message_id?: string;
};

/** Marks a channel as read up to the given message ID. */
export function markRead(serverId: string, channelId: string, messageId: string, options?: { timeoutMs?: number; signal?: AbortSignal; isCurrent?: () => boolean }) {
  return apiClient<{ message: string }>(`/servers/${serverId}/channels/${channelId}/read`, {
    ...options,
    method: "POST",
    body: { message_id: messageId },
  });
}

export function markUnreadFrom(serverId: string, channelId: string, messageId: string) {
  return apiClient<{ unread_count: number }>(`/servers/${serverId}/channels/${channelId}/unread`, {
    method: "POST",
    body: { message_id: messageId },
  });
}

/** Returns unread counts for all channels in a server (only channels with unread > 0). */
export function getUnreadCounts(serverId: string, options?: { signal?: AbortSignal; timeoutMs?: number; isCurrent?: () => boolean }) {
  return apiClient<UnreadInfo[]>(`/servers/${serverId}/channels/unread`, options);
}

/** Marks all channels in a server as read. */
export function markAllRead(serverId: string, options?: { timeoutMs?: number; signal?: AbortSignal; isCurrent?: () => boolean }) {
  return apiClient<{ message: string }>(`/servers/${serverId}/channels/read-all`, {
    ...options,
    method: "POST",
  });
}
