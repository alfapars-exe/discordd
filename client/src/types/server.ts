/**
 * Server types — top-level community grouping (Discord-style guild).
 */

export type Server = {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  invite_required: boolean;
  is_community?: boolean;
  e2ee_enabled: boolean;
  livekit_instance_id: string | null;
  afk_timeout_minutes: number;
  member_count: number;
  created_at: string;
};

/** Lightweight server info for sidebar rendering (WS ready + GET /api/servers). */
export type ServerListItem = {
  id: string;
  name: string;
  icon_url: string | null;
  /** Current user's persisted join-time audience, not another member's preference. */
  game_activity_audience?: boolean;
};

/**
 * host_type:
 * - "mqvi_hosted": Platform-managed LiveKit instance
 * - "self_hosted": User provides their own LiveKit URL/key/secret
 */
export type CreateServerRequest = {
  name: string;
  host_type: "mqvi_hosted" | "self_hosted";
  livekit_url?: string;
  livekit_key?: string;
  livekit_secret?: string;
};

export type JoinServerRequest = {
  invite_code: string;
};
