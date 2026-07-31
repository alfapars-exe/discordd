/**
 * WebSocket protocol — discriminated union of inbound event frames.
 *
 * `WSPayloadMap` maps each server→client `op` code to the exact shape the
 * corresponding handler expects in `msg.d`. `WSMessage` is derived from it as
 * a discriminated union keyed by `op`, so `switch (msg.op)` narrows `msg.d`
 * automatically — the per-case `msg.d as SomeType` casts in the handlers
 * become redundant (but stay valid because each payload type below matches
 * the cast exactly).
 *
 * Only INBOUND ops appear here (everything a handler switches on). Outbound
 * frames (heartbeat, typing, voice_join, …) are built as inline object
 * literals in useWebSocket.ts and are not typed through this union.
 *
 * Domains: system (systemEventHandlers), channel (channelEventHandlers),
 * dm (dmEventHandlers), voice (voiceEventHandlers).
 */

import type {
  MemberWithRoles,
  Role,
  UserBadge,
} from "./role";
import type { Server, ServerListItem } from "./server";
import type { UserStatus } from "./user";
import type { FriendshipWithUser } from "./friend";
import type { P2PCall, P2PSignalPayload } from "./p2p";
import type { AuditLog } from "./audit";
import type { SoundboardSound, SoundboardPlayEvent } from "./soundboard";
import type { Channel, Category, ChannelPermissionOverride } from "./channel";
import type { Message, PinnedMessage } from "./message";
import type { ReactionGroup } from "./common";
import type { DMChannelWithUser, DMMessage } from "./dm";
import type { VoiceState, VoiceStateUpdateData } from "./voice";
import type { MusicBotChannelState } from "./music";

/**
 * op → `d` payload shape for every inbound WS event.
 *
 * Payloads with no meaningful body (the handler ignores `msg.d`) map to
 * `unknown`: heartbeat_ack, prekey_low, device_list_update/device_key_change,
 * channel_create, channel_reorder, category_reorder, voice_force_disconnect,
 * voice_replaced.
 */
export interface WSPayloadMap {
  // ─── System ───
  heartbeat_ack: unknown;
  ready: {
    online_user_ids: string[];
    servers: ServerListItem[];
    muted_server_ids: string[];
    muted_channel_ids: string[];
    pref_status: string;
  };
  presence_update: { user_id: string; status: UserStatus };
  member_join: MemberWithRoles;
  audit_event: AuditLog;
  member_leave: { user_id: string };
  member_update: MemberWithRoles;
  member_timeout: {
    server_id: string;
    user_id: string;
    expires_at: string;
    reason?: string;
    applied_by?: string;
  };
  member_timeout_remove: { server_id: string; user_id: string };
  role_create: Role;
  role_update: Role;
  role_delete: { id: string };
  roles_reorder: Role[];
  server_update: Server;
  server_create: ServerListItem;
  server_delete: { id: string };
  friend_request_create: FriendshipWithUser;
  friend_request_accept: FriendshipWithUser;
  friend_request_decline: { id: string; user_id: string };
  friend_remove: { user_id: string };
  user_block: { user_id: string; blocked_user_id: string };
  user_unblock: { user_id: string; unblocked_user_id: string };
  p2p_call_initiate: P2PCall;
  p2p_call_accept: { call_id: string };
  p2p_call_decline: { call_id: string; reason?: string };
  p2p_call_end: { call_id: string; reason?: string };
  p2p_call_busy: { receiver_id: string };
  p2p_signal: P2PSignalPayload;
  prekey_low: unknown;
  // Since the C-03 follow-up, device_list_update is ALSO broadcast to every
  // server the owner belongs to (device_service.broadcastToUserServers), not
  // just to the owner's own sessions — other members must learn that a new
  // device exists, or the sender-key roster never re-seals for it.
  // device_key_change stays owner-only: a signed-prekey rotation does not
  // change the device SET, and the roster fingerprint is computed over
  // userId:deviceId pairs, so it cannot move.
  device_list_update: {
    user_id: string;
    action: "added" | "removed";
    device_id: string;
  };
  device_key_change: unknown;
  // Sent via BroadcastToUsers to the recipients of a v2 sender-key envelope
  // set (not server-wide) whenever a channel's Sender Key is (re)sealed —
  // e.g. after a roster change triggers rotation. See channelEncryption.ts
  // for the lazy-pull envelope fetch this notification complements.
  group_session_new: {
    channel_id: string;
    sender_user_id: string;
    sender_device_id: string;
    session_id: string;
  };
  badge_assign: { user_id: string; user_badge: UserBadge };
  badge_unassign: { user_id: string; badge_id: string };
  soundboard_sound_create: SoundboardSound;
  soundboard_sound_update: SoundboardSound;
  soundboard_sound_delete: { id: string; server_id: string };
  soundboard_play: SoundboardPlayEvent;

  // ─── Channel ───
  channel_create: unknown;
  channel_update: Channel;
  channel_delete: { id: string };
  channel_reorder: unknown;
  category_create: Category;
  category_update: Category;
  category_delete: { id: string };
  category_reorder: unknown;
  message_create: Message;
  message_update: Message;
  message_delete: { id: string; channel_id: string };
  typing_start: { channel_id: string; username: string };
  message_pin: PinnedMessage;
  message_unpin: { message_id: string; channel_id: string };
  reaction_update: {
    message_id: string;
    channel_id: string;
    reactions: ReactionGroup[];
    actor_id: string;
    message_author_id: string;
    added: boolean;
  };
  channel_permission_update: ChannelPermissionOverride;
  channel_permission_delete: { channel_id: string; role_id: string };

  // ─── DM ───
  dm_channel_create: DMChannelWithUser;
  dm_channel_update: DMChannelWithUser;
  dm_message_create: DMMessage;
  dm_message_update: DMMessage;
  dm_message_delete: { id: string; dm_channel_id: string };
  dm_reaction_update: {
    dm_message_id: string;
    dm_channel_id: string;
    reactions: ReactionGroup[];
  };
  dm_typing_start: { user_id: string; username: string; dm_channel_id: string };
  dm_message_pin: { dm_channel_id: string; message: DMMessage };
  dm_message_unpin: { dm_channel_id: string; message_id: string };
  dm_settings_update: { dm_channel_id: string; action: string };
  dm_channel_status_change: {
    dm_channel_id: string;
    status: "accepted" | "pending";
    initiated_by: string | null;
  };
  dm_request_accept: { dm_channel_id: string };
  dm_request_decline: { dm_channel_id: string };

  // ─── Voice ───
  voice_state_update: VoiceStateUpdateData;
  screen_share_viewer_update: {
    streamer_user_id: string;
    channel_id: string;
    viewer_count: number;
    viewer_user_id: string;
    action: string;
  };
  voice_states_sync: { states: VoiceState[] };
  voice_force_move: { channel_id: string; channel_name?: string };
  voice_force_disconnect: unknown;
  voice_afk_kick: { channel_name: string; server_name: string };
  voice_replaced: unknown;
  voice_passphrase_rotated: { channel_id: string; passphrase: string };
  music_bot_state: { channel_id?: string; state?: MusicBotChannelState };
  music_bot_error: { track_title?: string; reason?: string };
}

/**
 * Envelope fields shared by every WS frame, independent of `op`.
 *   - seq:       server-assigned monotonic sequence (resume/replay bookkeeping)
 *   - server_id: injected by BroadcastToServer for server-scoped events
 */
export interface WSEnvelope {
  seq?: number;
  server_id?: string;
}

/**
 * Inbound WS frame — discriminated union keyed by `op`. Narrowing on
 * `msg.op` (e.g. in a `switch`) narrows `msg.d` to the matching payload.
 */
export type WSMessage = {
  [K in keyof WSPayloadMap]: { op: K; d: WSPayloadMap[K] } & WSEnvelope;
}[keyof WSPayloadMap];
