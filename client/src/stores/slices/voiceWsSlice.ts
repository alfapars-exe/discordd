/**
 * voiceWsSlice — WebSocket event handlers for voice state.
 *
 * Pure state transformers — no side effects beyond updating Zustand state.
 * Handlers cross-slice: disconnect handlers also reset screenshare fields
 * owned by voiceScreenShareSlice. Legal because slices share a single store.
 */

import type { StateCreator } from "zustand";
import type { VoiceState, VoiceStateUpdateData } from "../../types";
import type { VoiceStore } from "../voiceStore";
import { clearVoiceRecoveryMark } from "../shared/voiceRecovery";

export type VoiceWsSlice = {
  afkKickInfo: { channelName: string; serverName: string } | null;

  handleVoiceStateUpdate: (data: VoiceStateUpdateData, epoch?: string, revision?: number) => boolean;
  handleVoiceStatesSync: (states: VoiceState[], epoch?: string, revision?: number) => boolean;
  setVoiceEpoch: (epoch?: string) => void;
  markVoiceChannelDeleted: (channelId: string) => void;
  markVoiceChannelCreated: (channelId: string) => void;
  updateUserInfo: (userId: string, displayName: string, avatarUrl: string) => void;
  handleForceDisconnect: () => void;
  handleAFKKick: (channelName: string, serverName: string) => void;
  handleVoiceReplaced: () => void;
  handleScreenShareViewerUpdate: (data: {
    streamer_user_id: string;
    channel_id: string;
    viewer_count: number;
    viewer_user_id: string;
    viewer_user_ids?: string[] | null;
    action: string;
  }, epoch?: string, revision?: number) => boolean;
  dismissAFKKick: () => void;
};

export const createVoiceWsSlice: StateCreator<
  VoiceStore,
  [],
  [],
  VoiceWsSlice
> = (set) => {
  // These overlays contain only deltas newer than the most recent snapshot.
  // They are connection-local and are discarded when the server epoch changes.
  const userRevisions = new Map<string, { revision: number; state: VoiceState | null }>();
  const viewerRevisions = new Map<string, { revision: number; channelId: string; viewers: string[] }>();
  const deletedChannels = new Set<string>();
  let activeEpoch: string | null = null;
  let snapshotRevision = 0;

  const adoptEpoch = (epoch?: string): boolean => {
    if (!epoch) return true;
    if (activeEpoch !== null && activeEpoch !== epoch) {
      userRevisions.clear();
      viewerRevisions.clear();
      deletedChannels.clear();
      snapshotRevision = 0;
    }
    activeEpoch = epoch;
    return true;
  };

  return ({
  afkKickInfo: null,

  setVoiceEpoch: (epoch?: string) => {
    adoptEpoch(epoch);
  },

  handleVoiceStateUpdate: (data: VoiceStateUpdateData, epoch?: string, revision?: number) => {
    if (epoch) {
      if (activeEpoch !== null && activeEpoch !== epoch) return false;
      adoptEpoch(epoch);
    }
    if (revision !== undefined && revision <= snapshotRevision) return false;
    const prior = userRevisions.get(data.user_id);
    if (revision !== undefined && prior && revision <= prior.revision) return false;
    if (deletedChannels.has(data.channel_id)) return false;

    let applied = false;
    set((state) => {
      const newStates = { ...state.voiceStates };
      let resultingState: VoiceState | null = null;

      switch (data.action) {
        case "join": {
          // Remove user from all channels (can only be in one)
          for (const channelId of Object.keys(newStates)) {
            newStates[channelId] = newStates[channelId].filter(
              (s) => s.user_id !== data.user_id
            );
            if (newStates[channelId].length === 0) {
              delete newStates[channelId];
            }
          }

          const channelStates = newStates[data.channel_id] ?? [];
          resultingState = {
              user_id: data.user_id,
              channel_id: data.channel_id,
              server_id: data.server_id,
              username: data.username,
              display_name: data.display_name,
              avatar_url: data.avatar_url,
              is_muted: data.is_muted,
              is_deafened: data.is_deafened,
              is_streaming: data.is_streaming,
              is_server_muted: data.is_server_muted,
              is_server_deafened: data.is_server_deafened,
          };
          newStates[data.channel_id] = [...channelStates, resultingState];
          break;
        }

        case "leave": {
          if (newStates[data.channel_id]) {
            newStates[data.channel_id] = newStates[data.channel_id].filter(
              (s) => s.user_id !== data.user_id
            );
            if (newStates[data.channel_id].length === 0) {
              delete newStates[data.channel_id];
            }
          }
          break;
        }

        case "update": {
          // Updates carry a complete state payload. Upsert it even if the
          // snapshot has not arrived (or did not contain this participant).
          for (const channelId of Object.keys(newStates)) {
            newStates[channelId] = newStates[channelId].filter((s) => s.user_id !== data.user_id);
            if (newStates[channelId].length === 0) delete newStates[channelId];
          }
          resultingState = {
            user_id: data.user_id,
            channel_id: data.channel_id,
            server_id: data.server_id,
            username: data.username,
            display_name: data.display_name,
            avatar_url: data.avatar_url,
            is_muted: data.is_muted,
            is_deafened: data.is_deafened,
            is_streaming: data.is_streaming,
            is_server_muted: data.is_server_muted,
            is_server_deafened: data.is_server_deafened,
          };
          newStates[data.channel_id] = [...(newStates[data.channel_id] ?? []), resultingState];
          break;
        }
      }

      if (revision !== undefined) userRevisions.set(data.user_id, { revision, state: resultingState });
      applied = true;
      return { voiceStates: newStates };
    });
    return applied;
  },

  handleVoiceStatesSync: (states: VoiceState[], epoch?: string, revision?: number) => {
    if (epoch && activeEpoch !== null && activeEpoch !== epoch) return false;
    if (epoch) adoptEpoch(epoch);
    const watermark = revision ?? snapshotRevision;
    if (revision !== undefined && watermark < snapshotRevision) return false;
    const grouped: Record<string, VoiceState[]> = {};
    // Seed the viewer map from the sync payload so a freshly-connected
    // client doesn't have to wait for a join/leave delta before it can
    // render "who's already watching this streamer". Server only populates
    // screen_share_viewers when IsStreaming, so the check is implicit.
    const viewerSeed: Record<string, string[]> = {};

    for (const state of states) {
      if (deletedChannels.has(state.channel_id)) continue;
      if (!grouped[state.channel_id]) {
        grouped[state.channel_id] = [];
      }
      grouped[state.channel_id].push(state);
      if (state.screen_share_viewers && state.screen_share_viewers.length > 0) {
        viewerSeed[state.user_id] = state.screen_share_viewers;
      }
    }

    for (const [userId, overlay] of userRevisions) {
      if (overlay.revision <= watermark) {
        userRevisions.delete(userId);
        continue;
      }
      for (const channelId of Object.keys(grouped)) {
        grouped[channelId] = grouped[channelId].filter((entry) => entry.user_id !== userId);
        if (grouped[channelId].length === 0) delete grouped[channelId];
      }
      if (overlay.state && !deletedChannels.has(overlay.state.channel_id)) {
        const channelStates = grouped[overlay.state.channel_id] ?? [];
        const snapshotState = states.find((entry) => entry.user_id === userId
          && entry.channel_id === overlay.state?.channel_id);
        const mergedState = overlay.state.screen_share_viewers === undefined && snapshotState
          ? { ...overlay.state, screen_share_viewers: snapshotState.screen_share_viewers }
          : overlay.state;
        grouped[overlay.state.channel_id] = [...channelStates, mergedState];
      }
    }

    // User overlays can move or remove a streamer. Rebuild snapshot viewers
    // from the merged states so stale snapshot data cannot leave orphaned viewers.
    for (const key of Object.keys(viewerSeed)) delete viewerSeed[key];
    for (const channelStates of Object.values(grouped)) {
      for (const state of channelStates) {
        if (state.is_streaming && state.screen_share_viewers?.length) {
          viewerSeed[state.user_id] = state.screen_share_viewers;
        }
      }
    }

    for (const [streamerId, overlay] of viewerRevisions) {
      if (overlay.revision <= watermark) {
        viewerRevisions.delete(streamerId);
        continue;
      }
      const streamer = Object.values(grouped).flat().find((entry) => entry.user_id === streamerId);
      if (!streamer || !streamer.is_streaming || streamer.channel_id !== overlay.channelId || deletedChannels.has(overlay.channelId)) {
        delete viewerSeed[streamerId];
        viewerRevisions.delete(streamerId);
        continue;
      }
      if (overlay.viewers.length > 0) viewerSeed[streamerId] = overlay.viewers;
      else delete viewerSeed[streamerId];
    }

    if (revision !== undefined) snapshotRevision = watermark;
    set({ voiceStates: grouped, screenShareViewers: viewerSeed });
    return true;
  },

  markVoiceChannelDeleted: (channelId: string) => {
    if (channelId) deletedChannels.add(channelId);
  },

  markVoiceChannelCreated: (channelId: string) => {
    if (channelId) deletedChannels.delete(channelId);
  },

  updateUserInfo: (userId, displayName, avatarUrl) => {
    set((state) => {
      let changed = false;
      const newStates = { ...state.voiceStates };

      for (const channelId of Object.keys(newStates)) {
        const idx = newStates[channelId].findIndex((s) => s.user_id === userId);
        if (idx !== -1) {
          const entry = newStates[channelId][idx];
          if (entry.display_name !== displayName || entry.avatar_url !== avatarUrl) {
            const newArr = [...newStates[channelId]];
            newArr[idx] = { ...entry, display_name: displayName, avatar_url: avatarUrl };
            newStates[channelId] = newArr;
            changed = true;
          }
        }
      }

      return changed ? { voiceStates: newStates } : {};
    });
  },

  handleForceDisconnect: () => {
    console.warn("[voiceStore] handleForceDisconnect CALLED", { timestamp: new Date().toISOString() });
    clearVoiceRecoveryMark();
    // Admin force-disconnected us — same cleanup as leave but no WS event sent
    // (server already cleared state). isMuted/isDeafened preserved.
    set({
      currentVoiceChannelId: null,
      currentVoiceServerId: null,
      livekitUrl: null,
      livekitToken: null,
      e2eePassphrase: null,
      isStreaming: false,
      activeSpeakers: {},
      watchingScreenShares: {},
      screenShareViewers: {},
      rtt: 0,
      connectionQuality: {},
    });
  },

  handleAFKKick: (channelName: string, serverName: string) => {
    console.warn("[voiceStore] handleAFKKick CALLED", { timestamp: new Date().toISOString(), channelName, serverName });
    clearVoiceRecoveryMark();
    set({
      currentVoiceChannelId: null,
      currentVoiceServerId: null,
      livekitUrl: null,
      livekitToken: null,
      e2eePassphrase: null,
      isStreaming: false,
      activeSpeakers: {},
      watchingScreenShares: {},
      screenShareViewers: {},
      rtt: 0,
      connectionQuality: {},
      afkKickInfo: { channelName, serverName },
    });
  },

  dismissAFKKick: () => set({ afkKickInfo: null }),

  handleVoiceReplaced: () => {
    console.warn("[voiceStore] handleVoiceReplaced CALLED", { timestamp: new Date().toISOString() });
    clearVoiceRecoveryMark();
    // Another session took over voice — leave silently, skip auto-rejoin.
    set({
      wasReplaced: true,
      currentVoiceChannelId: null,
      currentVoiceServerId: null,
      livekitUrl: null,
      livekitToken: null,
      e2eePassphrase: null,
      isStreaming: false,
      activeSpeakers: {},
      watchingScreenShares: {},
      screenShareViewers: {},
      rtt: 0,
      connectionQuality: {},
    });
  },

  handleScreenShareViewerUpdate: (data, epoch?: string, revision?: number) => {
    if (epoch) {
      if (activeEpoch !== null && activeEpoch !== epoch) return false;
      adoptEpoch(epoch);
    }
    if (revision !== undefined && revision <= snapshotRevision) return false;
    const prior = viewerRevisions.get(data.streamer_user_id);
    if (revision !== undefined && prior && revision <= prior.revision) return false;
    if (deletedChannels.has(data.channel_id)) return false;
    let applied = false;
    set((state) => {
      const next = { ...state.screenShareViewers };
      // Incrementally rebuild the viewer set from each join/leave delta.
      // The viewer_count carried by the event is a server-authoritative
      // fallback: when it drops to 0 we hard-clear the entry (covers the
      // "streamer stopped sharing" case where action is "leave" but no
      // single viewer_user_id meaningfully represents the global drop).
      const current = new Set<string>(next[data.streamer_user_id] ?? []);
      if (data.viewer_user_ids !== undefined) {
        current.clear();
        for (const viewerId of data.viewer_user_ids ?? []) current.add(viewerId);
      } else if (data.action === "join" && data.viewer_user_id) {
        current.add(data.viewer_user_id);
      } else if (data.action === "leave" && data.viewer_user_id) {
        current.delete(data.viewer_user_id);
      }
      // Server-driven cleanup wins when count says 0 (streamer left, etc.)
      if (data.viewer_count <= 0) {
        delete next[data.streamer_user_id];
      } else if (current.size > 0) {
        next[data.streamer_user_id] = Array.from(current);
      } else {
        delete next[data.streamer_user_id];
      }
      if (revision !== undefined) {
        viewerRevisions.set(data.streamer_user_id, {
          revision,
          channelId: data.channel_id,
          viewers: [...(next[data.streamer_user_id] ?? [])],
        });
      }
      applied = true;
      return { screenShareViewers: next };
    });
    return applied;
  },
  });
};
