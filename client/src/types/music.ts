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
};

export type PlayMusicResponse = {
  added_tracks: MusicTrack[];
};
