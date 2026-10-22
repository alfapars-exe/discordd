/**
 * Entrance sounds (Faz E, Sözleşme §5/§8).
 *
 * A user picks, per scope (global or one server), either a parametric preset
 * (synthesized client-side, no file) or one of their uploaded clips (≤5,
 * server-measured PCM WAV). The server alone decides when one plays and
 * broadcasts `entrance_sound_play` to the joined channel's participants.
 */

export type EntranceTheme = "chime" | "rise" | "fall" | "arcade" | "bell" | "fanfare";
export type EntranceWaveform = "sine" | "triangle" | "square" | "sawtooth";

export type EntrancePreset = {
  v: 1;
  theme: EntranceTheme;
  waveform: EntranceWaveform;
  pitch: number;
  duration_ms: number;
};

export type EntranceSound = {
  id: string;
  name: string;
  url: string;
  duration_ms: number;
  size: number;
  created_at: string;
};

export type EntranceSelection = {
  scope: string;
  kind: "clip" | "preset";
  sound_id: string | null;
  preset: EntrancePreset | null;
  updated_at: string;
};

export type ServerEntranceSettings = {
  server_id: string;
  enabled: boolean;
  max_duration_ms: number;
  disabled_channel_ids: string[];
};

export type EntranceSoundPlayEvent = {
  server_id: string;
  channel_id: string;
  user_id: string;
  kind: "clip" | "preset";
  sound_url?: string;
  preset?: EntrancePreset;
  play_ms: number;
};

/** Body of `PUT /api/users/me/entrance-selection`; `kind: "none"` clears the scope. */
export type EntranceSelectionInput = {
  scope: string;
  kind: "clip" | "preset" | "none";
  sound_id?: string;
  preset?: EntrancePreset;
};
