/**
 * Platform admin list/report types — backend pre-aggregates these
 * with correlated subqueries so the admin UI can render dashboards
 * without N+1 calls.
 */

/** Server info for platform admin panel (single SQL query with stats). */
export type AdminServerListItem = {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  owner_username: string;
  created_at: string;
  is_platform_managed: boolean;
  livekit_instance_id: string | null;
  member_count: number;
  channel_count: number;
  message_count: number;
  storage_mb: number;
  last_activity: string | null;
};

/** User info for platform admin panel (correlated subquery pattern). */
export type AdminUserListItem = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  is_platform_admin: boolean;
  created_at: string;
  status: string;
  last_activity: string | null;
  message_count: number;
  storage_mb: number;
  owned_self_servers: number;
  owned_mqvi_servers: number;
  member_server_count: number;
  ban_count: number;
  is_platform_banned: boolean;
};

export type ReportAttachment = {
  id: string;
  report_id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
};

export type AdminReportListItem = {
  source_kind?: "channel" | "dm" | "group";
  source_server_id?: string;
  source_channel_id?: string;
  source_message_id?: string;
  evidence_shared?: boolean;
  evidence_content?: string;
  id: string;
  reporter_id: string;
  reported_user_id: string;
  reason: string;
  description: string;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  reporter_username: string;
  reporter_display_name: string | null;
  reported_username: string;
  reported_display_name: string | null;
  attachments: ReportAttachment[];
};
