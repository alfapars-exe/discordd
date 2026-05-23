/**
 * User types — identity + presence.
 *
 * `User` is the API shape returned by /api/users/me and embedded in
 * many other resources (Message.author, DMChannelWithUser.other_user,
 * etc). Keep this file dependency-free so every domain module above
 * can import it cheaply.
 */

export type UserStatus = "online" | "idle" | "dnd" | "offline";

export type User = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  wallpaper_url?: string | null;
  status: UserStatus;
  custom_status: string | null;
  email: string | null;
  language: string;
  dm_privacy: "everyone" | "message_request" | "friends_only";
  is_platform_admin: boolean;
  has_seen_download_prompt: boolean;
  has_seen_welcome: boolean;
  created_at: string;
};
