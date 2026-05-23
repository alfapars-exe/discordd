/**
 * Application log types — structured runtime logs (errors/warnings)
 * exposed to admins via the Logs panel. Separate from audit logs:
 * applog is for engineering visibility, audit is for moderation.
 */

export type AppLogLevel = "error" | "warn" | "info";
export type AppLogCategory = "voice" | "video" | "screen_share" | "ws" | "auth" | "general" | "feedback" | "livekit";

export type AppLog = {
  id: string;
  level: AppLogLevel;
  category: AppLogCategory;
  user_id: string | null;
  server_id: string | null;
  message: string;
  metadata: string;
  created_at: string;
  username: string | null;
  display_name: string | null;
};
