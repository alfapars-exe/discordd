/**
 * Channel types — text/voice/audit channel shapes, categories, and
 * per-channel permission overrides.
 *
 * "audit" is the moderation event feed — read-only, gated by Admin or
 * any of Kick/Ban/Mute/Deafen perms server-side. Auto-created per server
 * in server_service.CreateServer (and backfilled into existing servers
 * by migration 061). UI hides the composer when type === "audit".
 */

export type ChannelType = "text" | "voice" | "audit" | "thread";

export type Channel = {
  id: string;
  name: string;
  type: ChannelType;
  category_id: string | null;
  topic: string | null;
  position: number;
  user_limit: number;
  bitrate: number;
  created_at: string;
  parent_channel_id?: string | null;
  starter_message_id?: string | null;
  archived_at?: string | null;
  reply_count?: number;
  /** Requesting user's server-resolved bits, when supplied by channel listing. */
  effective_permissions?: number;
};

export type Category = {
  id: string;
  name: string;
  position: number;
};

/** Grouped structure returned by GET /api/channels. */
export type CategoryWithChannels = {
  category: Category;
  channels: Channel[];
};

/**
 * Discord-style channel permission override.
 * - allow: bits added to role's default permissions
 * - deny: bits removed from role's default permissions
 * - Both 0: inherit (role defaults apply)
 */
export type ChannelPermissionOverride = {
  channel_id: string;
  role_id: string;
  allow: number;
  deny: number;
};
