/**
 * Notification types — server-persisted activity feed
 * (mentions, replies, friend requests, DM requests, system).
 *
 * Mirrors the Go `Notification` struct. `payload` is a per-kind bag:
 *   mention | reply   : { preview: string | null, channel_name: string }
 *   friend_request    : { friendship_id: string }
 *   dm_request        : {}
 *   system            : { title: string, body: string } or { action: "profile_update" }
 * `preview` is plaintext only — null for E2EE / file-only messages.
 */

import type { PublicUser } from "./user";

export type NotificationKind =
  | "mention"
  | "reply"
  | "friend_request"
  | "dm_request"
  | "system";

export type AppNotification = {
  id: string;
  user_id: string;
  kind: NotificationKind;
  actor_id: string | null;
  actor: PublicUser | null;
  server_id: string | null;
  channel_id: string | null;
  message_id: string | null;
  dm_channel_id: string | null;
  group_dm_channel_id?: string | null;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

export type NotificationPage = {
  notifications: AppNotification[];
  has_more: boolean;
};
