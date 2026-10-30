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
import type { GroupDM, GroupDMMessage } from "./groupDM";
import type { VoiceState, VoiceStateUpdateData } from "./voice";
import type { MusicBotChannelState } from "./music";
import type { AppNotification } from "./notification";
import type { EntranceSoundPlayEvent } from "./entrance";
import type { CosmeticsUpdateEvent } from "./cosmetics";
import type {
  ServerEmoji,
  ServerEmojiDeleteEvent,
  ServerSticker,
  ServerStickerDeleteEvent,
} from "./expression";

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
    durable_channel_sends?: boolean;
    online_user_ids: string[];
    servers: ServerListItem[];
    muted_server_ids: string[];
    muted_channel_ids: string[];
    pref_status: string;
    voice_epoch?: string;
    game_activity_epoch?: string;
  };
  game_activity_update: import("../stores/gameActivityStore").GameActivityUpdate;
  game_join_offer_state: import("../stores/gameJoinStore").GameJoinOfferState;
  preferences_changed: { user_id: string };
  profile_audience_invalidated: { user_id: string };
  presence_update: { user_id: string; status: UserStatus; is_auto?: boolean };
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
  // Entrance sounds (Faz E) — BroadcastToUsers (joined channel only); entranceEventHandlers.
  entrance_sound_play: EntranceSoundPlayEvent;
  // Cosmetics (Faz G) — BroadcastToServer / BroadcastToUser (self); cosmeticsEventHandlers.
  user_cosmetics_update: CosmeticsUpdateEvent;
  // Custom emojis (Faz D1) — BroadcastToServer; handled by expressionEventHandlers.
  server_emoji_create: ServerEmoji;
  server_emoji_update: ServerEmoji;
  server_emoji_delete: ServerEmojiDeleteEvent;
  // Server stickers (Faz D2) — BroadcastToServer; handled by expressionEventHandlers.
  server_sticker_create: ServerSticker;
  server_sticker_update: ServerSticker;
  server_sticker_delete: ServerStickerDeleteEvent;
  // Persisted activity feed (mentions / replies / friend + DM requests).
  // Sent only to the recipient's own sessions.
  notification_create: AppNotification;
  spam_decision: import("../stores/spamDecisionStore").SpamDecision;
  media_label_changed: import("../utils/mediaLabelSync").MediaLabelChange;
  // Read-cursor sync across the recipient's devices (after a REST read call).
  notification_read: { ids: string[]; all: boolean; unread_count: number };

  // ─── Channel ───
  channel_create: Channel;
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
  // Echoed to the reader's own sessions after POST /dms/{id}/read so other
  // devices drop their local unread count for that channel.
  dm_read: { dm_channel_id: string; user_id: string; last_read_message_id: string | null };
  group_dm_create: GroupDM;
  group_dm_update: GroupDM;
  group_dm_delete: { group_id: string };
  group_dm_rekey: { group_id: string; key_epoch: number };
  group_dm_message_create: GroupDMMessage;
  group_dm_message_update: GroupDMMessage;
  group_dm_message_delete: { group_id: string; id: string };
  group_dm_pins_update: { group_id: string; message_id: string; pinned: boolean };
  group_dm_reaction_update: { group_id: string; message_id: string; reactions: ReactionGroup[] };
  group_dm_read: { group_id: string; last_read_message_id: string | null; unread_count: number; revision?: number };
  group_dm_refresh: { reason: string };

  // ─── Voice ───
  voice_state_update: VoiceStateUpdateData;
  screen_share_viewer_update: {
    streamer_user_id: string;
    channel_id: string;
    viewer_count: number;
    viewer_user_id: string;
    viewer_user_ids?: string[] | null;
    action: string;
  };
  voice_states_sync: { states: VoiceState[]; voice_epoch?: string; voice_revision?: number };
  voice_force_move: { channel_id: string; channel_name?: string };
  voice_force_disconnect: unknown;
  voice_afk_kick: { channel_name: string; server_name: string };
  voice_replaced: unknown;
  voice_passphrase_rotated: { channel_id: string; passphrase: string; key_index?: number; key_epoch?: number; key_context?: string };
  music_bot_state: { channel_id?: string; state?: MusicBotChannelState };
  // `reason` stays `string` on the wire: it is untrusted and a newer server
  // may send a code this client doesn't know. Narrow with
  // isMusicBotErrorReason (types/music.ts) before using it.
  music_bot_error: {
    channel_id: string;
    server_id: string;
    track_title: string;
    reason: string;
    failures: number;
    fatal: boolean;
  };
}

/**
 * Envelope fields shared by every WS frame, independent of `op`.
 *   - seq:       server-assigned monotonic sequence (resume/replay bookkeeping)
 *   - server_id: injected by BroadcastToServer for server-scoped events
 */
export interface WSEnvelope {
  event_id?: string;
  channel_sequence?: number;
  seq?: number;
  server_id?: string;
  /** Voice-domain mutation fence, separate from the transport sequence. */
  voice_epoch?: string;
  voice_revision?: number;
}

/**
 * Inbound WS frame — discriminated union keyed by `op`. Narrowing on
 * `msg.op` (e.g. in a `switch`) narrows `msg.d` to the matching payload.
 */
export type WSMessage = {
  [K in keyof WSPayloadMap]: { op: K; d: WSPayloadMap[K] } & WSEnvelope;
}[keyof WSPayloadMap];
