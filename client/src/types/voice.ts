/**
 * Voice types — LiveKit-backed group voice state.
 * P2P call shapes live in p2p.ts (separate WebRTC peer-to-peer path).
 */

/** Ephemeral voice state (in-memory only, not persisted to DB). */
export type VoiceState = {
  user_id: string;
  channel_id: string;
  /** Parent server — used for F5 recovery and server-scoped filtering. */
  server_id?: string;
  username: string;
  display_name: string;
  avatar_url: string;
  is_muted: boolean;
  is_deafened: boolean;
  is_streaming: boolean;
  /** Server-wide mute by admin */
  is_server_muted: boolean;
  /** Server-wide deafen by admin */
  is_server_deafened: boolean;
  /**
   * Active viewers of this user's screen share — only set when streaming.
   * Server populates this in voice_states_sync so a client joining
   * mid-session knows who's already watching whom. Optional because the
   * field is omitted when empty (matches Go's omitempty wire shape).
   */
  screen_share_viewers?: string[];
};

/** LiveKit token response from POST /api/voice/token. */
export type VoiceTokenResponse = {
  token: string;
  url: string;
  channel_id: string;
  /** Room-level E2EE passphrase (SFrame). Generated server-side. */
  e2ee_passphrase?: string;
};

/** voice_state_update WS event payload. */
export type VoiceStateUpdateData = {
  user_id: string;
  channel_id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  is_muted: boolean;
  is_deafened: boolean;
  is_streaming: boolean;
  is_server_muted: boolean;
  is_server_deafened: boolean;
  action: "join" | "leave" | "update";
};
