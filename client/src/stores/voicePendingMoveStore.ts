/**
 * voicePendingMoveStore — presentation-only overlay for the channel sidebar.
 *
 * Two things reach the sidebar late because they wait for a server
 * broadcast: a member a moderator just dropped on another voice channel, and
 * the user's own row while their join is in flight. This module lets the
 * sidebar draw both rows right away, marked as pending.
 *
 * Nothing here is authoritative. `voiceStates` is never written: participant
 * counts, permissions, the voice room view and sounds keep reading the server
 * state, and nothing in this module is sent to the server.
 */

import { create } from "zustand";
import type { User, VoiceState } from "../types";
import type { VoiceRecoveryPhase } from "./voiceRecoveryStore";

export type PendingVoiceMove = {
  userId: string;
  fromChannelId: string;
  toChannelId: string;
  startedAt: number;
};

/** userId -> the move awaiting its server broadcast. */
export type PendingVoiceMoves = Record<string, PendingVoiceMove>;

/**
 * The server reports a refused move only by not broadcasting it, so an
 * overlay nobody confirmed is rolled back after this long.
 */
export const PENDING_VOICE_MOVE_TTL_MS = 5000;

export function addPendingVoiceMove(moves: PendingVoiceMoves, move: PendingVoiceMove): PendingVoiceMoves {
  return { ...moves, [move.userId]: move };
}

export function clearPendingVoiceMove(moves: PendingVoiceMoves, userId: string): PendingVoiceMoves {
  if (!(userId in moves)) return moves;
  const next = { ...moves };
  delete next[userId];
  return next;
}

export function expirePendingVoiceMoves(moves: PendingVoiceMoves, now: number): PendingVoiceMoves {
  const live = Object.values(moves).filter((move) => now - move.startedAt < PENDING_VOICE_MOVE_TTL_MS);
  if (live.length === Object.keys(moves).length) return moves;
  return Object.fromEntries(live.map((move) => [move.userId, move]));
}

/** Local view of the signed-in user's own voice session. */
export type SidebarVoiceSelf = {
  user: Pick<User, "id" | "username" | "display_name" | "avatar_url"> | null;
  pendingVoiceChannelId: string | null;
  currentVoiceChannelId: string | null;
  /** Where the session's recovery stands (voiceRecoveryStore). */
  recoveryPhase: VoiceRecoveryPhase;
  isMuted: boolean;
  isDeafened: boolean;
  isServerMuted: boolean;
  isServerDeafened: boolean;
};

/**
 * The user's own row for the channel they are joining, or have joined
 * locally, until the server lists them there. Null once the authoritative
 * entry exists, so the row is never drawn twice.
 *
 * A session whose recovery has failed is not on its way anywhere, although
 * `currentVoiceChannelId` stays set until the user dismisses the failure.
 * The server may list the account in another channel by then (another
 * session of it joined there and this one was evicted) or nowhere at all, so
 * no row is drawn for it and the sidebar shows what the server lists. A new
 * join started from that state has `pendingVoiceChannelId` and its row again.
 */
export function ownPendingVoiceRow(
  voiceStates: Record<string, VoiceState[]>,
  self: SidebarVoiceSelf,
): VoiceState | null {
  const joinedChannelId = self.recoveryPhase === "failed" ? null : self.currentVoiceChannelId;
  const channelId = self.pendingVoiceChannelId ?? joinedChannelId;
  if (!self.user || !channelId) return null;
  const ownId = self.user.id;
  if (voiceStates[channelId]?.some((state) => state.user_id === ownId)) return null;
  return {
    user_id: ownId,
    channel_id: channelId,
    username: self.user.username,
    display_name: self.user.display_name ?? "",
    avatar_url: self.user.avatar_url ?? "",
    is_muted: self.isMuted,
    is_deafened: self.isDeafened,
    is_streaming: false,
    is_server_muted: self.isServerMuted,
    is_server_deafened: self.isServerDeafened,
  };
}

export type SidebarVoiceStates = {
  /** channelId -> rows to draw; `voiceStates` itself when nothing is pending. */
  byChannel: Record<string, VoiceState[]>;
  /** Users whose row is not confirmed by the server yet. */
  pendingUserIds: ReadonlySet<string>;
};

/**
 * Per-channel participant rows for the sidebar: the authoritative lists with
 * pending moves and the user's own pending row laid over them. Never mutates
 * its input.
 */
export function deriveSidebarVoiceStates(
  voiceStates: Record<string, VoiceState[]>,
  moves: PendingVoiceMoves,
  self: SidebarVoiceSelf,
): SidebarVoiceStates {
  const pendingUserIds = new Set<string>();
  let byChannel = voiceStates;
  const editable = () => {
    if (byChannel === voiceStates) byChannel = { ...voiceStates };
    return byChannel;
  };

  for (const move of Object.values(moves)) {
    if (move.fromChannelId === move.toChannelId) continue;
    // Only a member the server still lists in the source channel is shown
    // elsewhere; the row keeps their real name, avatar and flags.
    const entry = byChannel[move.fromChannelId]?.find((state) => state.user_id === move.userId);
    if (!entry) continue;
    const next = editable();
    next[move.fromChannelId] = next[move.fromChannelId].filter((state) => state.user_id !== move.userId);
    next[move.toChannelId] = [...(next[move.toChannelId] ?? []), { ...entry, channel_id: move.toChannelId }];
    pendingUserIds.add(move.userId);
  }

  const own = ownPendingVoiceRow(voiceStates, self);
  if (own) {
    const next = editable();
    // A user is in one voice channel at a time: while the join is in flight
    // a row the server still lists elsewhere would show them twice.
    for (const channelId of Object.keys(next)) {
      if (next[channelId].some((state) => state.user_id === own.user_id)) {
        next[channelId] = next[channelId].filter((state) => state.user_id !== own.user_id);
      }
    }
    next[own.channel_id] = [...(next[own.channel_id] ?? []), own];
    pendingUserIds.add(own.user_id);
  }

  return { byChannel, pendingUserIds };
}

type VoicePendingMoveStore = {
  moves: PendingVoiceMoves;
  /** Show `userId` under `toChannelId` until the server confirms or the overlay expires. */
  recordMove: (userId: string, fromChannelId: string, toChannelId: string) => void;
  /** An authoritative update for this user arrived. */
  clearMove: (userId: string) => void;
  /** An authoritative snapshot arrived. */
  clearAll: () => void;
};

export const useVoicePendingMoveStore = create<VoicePendingMoveStore>((set) => ({
  moves: {},

  recordMove: (userId, fromChannelId, toChannelId) => {
    const startedAt = Date.now();
    set((state) => ({ moves: addPendingVoiceMove(state.moves, { userId, fromChannelId, toChannelId, startedAt }) }));
    // The deadline, not the clock, is passed so a timer firing a moment
    // early still retires this move, and a newer move of the same user
    // (later deadline) survives it.
    setTimeout(() => {
      set((state) => {
        const moves = expirePendingVoiceMoves(state.moves, startedAt + PENDING_VOICE_MOVE_TTL_MS);
        return moves === state.moves ? {} : { moves };
      });
    }, PENDING_VOICE_MOVE_TTL_MS);
  },

  clearMove: (userId) =>
    set((state) => {
      const moves = clearPendingVoiceMove(state.moves, userId);
      return moves === state.moves ? {} : { moves };
    }),

  clearAll: () => set((state) => (Object.keys(state.moves).length === 0 ? {} : { moves: {} })),
}));
