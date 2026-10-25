/**
 * Application log types — structured runtime logs (errors/warnings)
 * exposed to admins via the Logs panel. Separate from audit logs:
 * applog is for engineering visibility, audit is for moderation.
 */

export type AppLogLevel = "error" | "warn" | "info";
export type AppLogCategory = "voice" | "video" | "screen_share" | "ws" | "auth" | "general" | "feedback" | "livekit" | "client";

export type AppLog = {
  id: string;
  level: AppLogLevel;
  category: AppLogCategory;
  user_id: string | null;
  server_id: string | null;
  message: string;
  metadata: string;
  created_at: string;
  request_id?: string;
  event_code?: string;
  component?: string;
  error_kind?: string;
  occurrence_count?: number;
  last_seen_at?: string;
  username: string | null;
  display_name: string | null;
};

export type AppLogHealth = {
 error_queue: number; normal_queue: number; error_capacity: number; normal_capacity: number;
 dropped_error: number; dropped_warn: number; dropped_info: number;
 write_failures: number; failed_events: number; excluded_deleted: number; grouped_events: number;
 last_success_at: string; retention_days: number;
};
