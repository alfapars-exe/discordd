/**
 * Music bot types + identity constants.
 *
 * Mirrors server/models/music_bot.go. The bot is a regular LiveKit
 * participant with identity `__music_bot__:{channelID}` — the frontend
 * uses this prefix to render the bot tile differently from human users.
 */

/** Literal users.id of the bot system user — see migration 060. */
export const MUSIC_BOT_USER_ID = "__music_bot__";

/** Returns true if a LiveKit participant identity belongs to a music bot. */
export function isMusicBotIdentity(identity: string): boolean {
  return identity === MUSIC_BOT_USER_ID || identity.startsWith(`${MUSIC_BOT_USER_ID}:`);
}

export type MusicTrack = {
  queue_item_id?: string;
  video_id: string;
  title: string;
  artist?: string;
  thumbnail?: string;
  duration_seconds: number;
  url: string;
  requested_by_user_id: string;
  requested_by_name: string;
};

export type MusicBotChannelState = {
  channel_id: string;
  server_id: string;
  is_active: boolean;
  current_track?: MusicTrack | null;
  queue: MusicTrack[];
  is_paused: boolean;
  /** RFC3339 timestamp when the current track started — clients compute elapsed locally. */
  started_at?: string | null;
  /** Server playback position excludes paused time; absent on older servers. */
  elapsed_seconds?: number;
  revision?: number;
  repeat_mode?: "off" | "one" | "all";
};

export type PlayMusicResponse = {
  added_tracks: MusicTrack[];
};

export type SearchMusicResponse = { results: MusicTrack[] };

/**
 * Reason codes the server attaches to a `music_bot_error` event. Mirrors the
 * musicBotErrorReason enum in server/services/music_bot_errors.go. Each code
 * maps to the `music:reason_<code>` i18n key; the parity test in
 * i18n/localeParity.test.ts fails if a code has no key in either locale.
 */
export const MUSIC_BOT_ERROR_REASONS = [
  "forbidden",
  "bot_check",
  "unavailable",
  "age_restricted",
  "geo_blocked",
  "rate_limited",
  "network",
  "stalled",
  "tool_missing",
  "unknown",
] as const;

export type MusicBotErrorReason = (typeof MUSIC_BOT_ERROR_REASONS)[number];

/**
 * Narrows an untrusted wire value to a known reason code. Anything else (a
 * newer server's code, a missing field, a crafted string) is rejected, so a
 * caller can never build an i18n key the server chose.
 */
export function isMusicBotErrorReason(x: unknown): x is MusicBotErrorReason {
  return typeof x === "string" && (MUSIC_BOT_ERROR_REASONS as readonly string[]).includes(x);
}
