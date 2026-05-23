/**
 * Audit log types — moderation event feed (rendered in "audit" channels).
 *
 * The server emits one row per moderation action; the client maps the
 * event_type string to a localized template at render time. DON'T
 * rename event_type values here without coordinating the server enum
 * (server/models/audit_log.go) + the i18n templates
 * (client/src/i18n/locales/{tr,en}/audit.json).
 */

export type AuditEventType =
  | "server_mute"
  | "server_unmute"
  | "server_deafen"
  | "server_undeafen"
  | "voice_kick"
  | "voice_move"
  | "member_join"
  | "member_leave"
  | "member_kick"
  | "member_ban"
  | "member_unban"
  | "role_create"
  | "role_delete"
  | "role_assign"
  | "role_remove"
  | "channel_create"
  | "channel_delete"
  | "channel_rename"
  | "message_delete";

/**
 * Frozen-in-time snapshot of an actor or target user — the server stores
 * this with each audit row so entries stay readable after the user is
 * deleted or renames themselves. Optional fields mirror the Go side
 * which uses `omitempty`.
 */
export type AuditUserSnapshot = {
  id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
};

export type AuditLog = {
  id: string;
  server_id: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  event_type: AuditEventType;
  /** Raw JSON string — caller parses if needed. */
  metadata: string;
  actor?: AuditUserSnapshot;
  target?: AuditUserSnapshot;
  created_at: string;
};
