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
  /** channelID → latest known state. Cleared when the user fully leaves voice. */
  musicBotStates: Record<string, MusicBotChannelState>;

  setMusicBotState: (channelId: string, state: MusicBotChannelState) => void;
  clearMusicBotState: (channelId: string) => void;
  resetMusicBotStates: () => void;
};

export const createMusicBotSlice: StateCreator<VoiceStore, [], [], MusicBotSlice> = (set) => ({
  musicBotStates: {},

  setMusicBotState: (channelId, state) =>
    set((s) => ({ musicBotStates: { ...s.musicBotStates, [channelId]: state } })),

  clearMusicBotState: (channelId) =>
    set((s) => {
      if (!(channelId in s.musicBotStates)) return s;
      const next = { ...s.musicBotStates };
      delete next[channelId];
      return { musicBotStates: next };
    }),

  resetMusicBotStates: () => set({ musicBotStates: {} }),
});
