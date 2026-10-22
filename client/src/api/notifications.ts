/**
 * Notifications API — persisted activity feed for the current user.
 *
 * List (cursor-paginated, newest first), unread count, mark one / all read.
 */

import { apiClient } from "./client";
import type { NotificationPage } from "../types";

export type ListNotificationsParams = {
  /** Cursor: return notifications older than this id. */
  before?: string;
  unreadOnly?: boolean;
  /** Clamped server-side to 1..50; default 20. */
  limit?: number;
};

export function listNotifications(params: ListNotificationsParams = {}) {
  const query = new URLSearchParams();
  if (params.before) query.set("before", params.before);
  if (params.unreadOnly) query.set("unread_only", "1");
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const qs = query.toString();
  return apiClient<NotificationPage>(`/users/me/notifications${qs ? `?${qs}` : ""}`);
}

export function getNotificationCount() {
  return apiClient<{ unread_count: number }>("/users/me/notifications/count");
}

export function markNotificationRead(id: string) {
  return apiClient<{ message: string }>(`/users/me/notifications/${id}/read`, {
    method: "POST",
  });
}

export function markAllNotificationsRead() {
  return apiClient<{ marked: number }>("/users/me/notifications/read-all", {
    method: "POST",
  });
}
