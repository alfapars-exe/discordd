/**
 * Soundboard types — server-uploaded short audio clips that any
 * member can play into a voice channel.
 */

export type SoundboardSound = {
  id: string;
  server_id: string;
  name: string;
  emoji: string | null;
  file_url: string;
  file_size: number;
  duration_ms: number;
  uploaded_by: string;
  created_at: string;
  uploader_username?: string;
  uploader_display_name?: string;
};

export type SoundboardPlayEvent = {
  sound_id: string;
  sound_name: string;
  sound_url: string;
  user_id: string;
  username: string;
  server_id: string;
  channel_id: string;
};
