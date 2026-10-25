/**
 * User types — identity + presence.
 *
 * `User` is the API shape returned by /api/users/me and embedded in
 * many other resources (Message.author, DMChannelWithUser.other_user,
 * etc). Keep this file dependency-free so every domain module above
 * can import it cheaply.
 */

export type UserStatus = "online" | "idle" | "dnd" | "offline";

/**
 * PublicUser — another user as embedded in message / DM / pin payloads.
 * The server narrowed these fields deliberately (security scan 2026-07-31,
 * finding N-09): email, is_platform_admin, is_platform_banned, dm_privacy,
 * wallpaper_url, language, pref_status, has_seen_* and last_seen_at were
 * being broadcast to everyone who could read the channel.
 */
export type PublicUser = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  status: UserStatus;
  custom_status: string | null;
  created_at: string;
  is_bot?: boolean;
};

/** The authenticated user's OWN record (GET /api/users/me, auth responses). */
export type User = PublicUser & {
  wallpaper_url?: string | null;
  /** Optional animated GIF avatar (128 px). `avatar_url` stays the static
   *  poster; this is only set after an animated upload. */
  avatar_animated_url?: string | null;
  /** Static profile banner (5:2, ≤1200×480). */
  banner_url?: string | null;
  banner_animated_url?: string | null;
  bio?: string | null;
  pronouns?: string | null;
  /** `#rrggbb`, lower-case. Banner fallback colour on the profile card. */
  accent_color?: string | null;
  email: string | null;
  language: string;
  dm_privacy: "everyone" | "message_request" | "friends_only";
  is_platform_admin: boolean;
  has_seen_download_prompt: boolean;
  has_seen_welcome: boolean;
};

/**
 * UserProfile — public profile of any user (GET /api/users/{userId}/profile).
 * Used by the MemberCard outside server context (DM, friends, inbox), where
 * only a PublicUser is at hand. Deliberately carries no presence (`status`)
 * and none of the N-09 private fields.
 */
export type UserProfile = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  avatar_animated_url: string | null;
  banner_url: string | null;
  banner_animated_url: string | null;
  bio: string | null;
  pronouns: string | null;
  accent_color: string | null;
  custom_status: string | null;
  is_bot: boolean;
  created_at: string;
};
