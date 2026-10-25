/**
 * musicBotSlice — per-channel music bot state cache.
 *
 * Backend pushes `music_bot_state` over the voice WebSocket whenever the
 * queue / current track / pause flag changes. We mirror those snapshots
 * here keyed by channelID so MusicBotPanel can subscribe to a single
 * channel's state without re-rendering when other channels update.
 *
 * Lifecycle:
 *   • Initial load: getMusicState() → setMusicBotState() on voice room mount
 *   • Updates: WS handler calls setMusicBotState() with each push
 *   • Bot stops: WS push with is_active=false → we keep the entry so the
 *     panel can show a brief "MusicBot kanaldan ayrıldı" toast, but it's
 *     filtered out of the active panel render
 */

import type { StateCreator } from "zustand";
import type { MusicBotChannelState } from "../../types";
import type { VoiceStore } from "../voiceStore";

export type MusicBotSlice = {
  /** channelID → latest known state. Cleared on account logout. */
  musicBotStates: Record<string, MusicBotChannelState>;
  /** Revisions also advance on clear, so late HTTP snapshots cannot resurrect a bot. */
  musicBotRevisions: Record<string, number>;
  musicBotUpdatedAt: Record<string, number>;
  /** Invalidates requests for previously unseen channels too on account reset. */
  musicBotResetRevision: number;

  setMusicBotState: (channelId: string, state: MusicBotChannelState) => void;
  clearMusicBotState: (channelId: string) => void;
  resetMusicBotStates: () => void;
};

export const createMusicBotSlice: StateCreator<VoiceStore, [], [], MusicBotSlice> = (set) => ({
  musicBotStates: {},
  musicBotRevisions: {},
  musicBotUpdatedAt: {},
  musicBotResetRevision: 0,

  setMusicBotState: (channelId, state) => {
    // Never associate a mismatched wire payload with another conversation.
    if (state.channel_id !== channelId || !state.server_id) return;
    set((s) => ({
      musicBotStates: { ...s.musicBotStates, [channelId]: { ...state, queue: Array.isArray(state.queue) ? state.queue : [] } },
      musicBotRevisions: { ...s.musicBotRevisions, [channelId]: (s.musicBotRevisions[channelId] ?? 0) + 1 },
      musicBotUpdatedAt: { ...s.musicBotUpdatedAt, [channelId]: Date.now() },
    }));
  },

  clearMusicBotState: (channelId) =>
    set((s) => {
      const next = { ...s.musicBotStates };
      delete next[channelId];
      return {
        musicBotStates: next,
        musicBotRevisions: { ...s.musicBotRevisions, [channelId]: (s.musicBotRevisions[channelId] ?? 0) + 1 },
        musicBotUpdatedAt: { ...s.musicBotUpdatedAt, [channelId]: Date.now() },
      };
    }),

  resetMusicBotStates: () => set((s) => ({
    musicBotStates: {},
    musicBotUpdatedAt: {},
    musicBotResetRevision: s.musicBotResetRevision + 1,
    musicBotRevisions: Object.fromEntries(Object.entries(s.musicBotRevisions).map(([id, revision]) => [id, revision + 1])),
  })),
});
