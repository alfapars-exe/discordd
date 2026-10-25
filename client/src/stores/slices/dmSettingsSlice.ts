import type { StateCreator } from "zustand";
import i18n from "../../i18n";
import * as dmApi from "../../api/dm";
import { useToastStore } from "../toastStore";
import { sortChannelsByActivity } from "../shared/dmSort";
import type { DMStore } from "../dmStore";

export type DMSettingsSlice = {
  dmUnreadCounts: Record<string, number>;
  pendingSearchChannelId: string | null;

  hideDM: (channelId: string) => Promise<void>;
  pinDM: (channelId: string) => Promise<void>;
  unpinDM: (channelId: string) => Promise<void>;
  muteDM: (channelId: string, duration: string) => Promise<void>;
  unmuteDM: (channelId: string) => Promise<void>;
  fetchDMSettings: () => Promise<void>;
  setPendingSearchChannelId: (id: string | null) => void;

  incrementDMUnread: (channelId: string) => void;
  decrementDMUnread: (channelId: string) => void;
  /** Local clear + server read-cursor advance (best-effort). */
  clearDMUnread: (channelId: string) => void;
  /** `dm_read` from another of our sessions: local clear only, no API call. */
  handleDMReadSync: (data: { dm_channel_id: string; unread_count?: number }) => void;
  /** Sum of unread counts, excluding muted channels. */
  getTotalDMUnread: () => number;
};

export const createDMSettingsSlice: StateCreator<
  DMStore,
  [],
  [],
  DMSettingsSlice
> = (set, get) => ({
  dmUnreadCounts: {},
  pendingSearchChannelId: null,

  hideDM: async (channelId) => {
    const res = await dmApi.hideDM(channelId);
    if (res.success) {
      set((state) => ({
        channels: state.channels.filter((ch) => ch.id !== channelId),
        selectedDMId: state.selectedDMId === channelId ? null : state.selectedDMId,
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmClosed"));
    }
  },

  pinDM: async (channelId) => {
    const res = await dmApi.pinDMConversation(channelId);
    if (res.success) {
      set((state) => ({
        channels: sortChannelsByActivity(
          state.channels.map((ch) =>
            ch.id === channelId ? { ...ch, is_pinned: true } : ch
          )
        ),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmPinned"));
    }
  },

  unpinDM: async (channelId) => {
    const res = await dmApi.unpinDMConversation(channelId);
    if (res.success) {
      set((state) => ({
        channels: sortChannelsByActivity(
          state.channels.map((ch) =>
            ch.id === channelId ? { ...ch, is_pinned: false } : ch
          )
        ),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmUnpinned"));
    }
  },

  muteDM: async (channelId, duration) => {
    const res = await dmApi.muteDM(channelId, duration);
    if (res.success) {
      set((state) => ({
        channels: state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, is_muted: true } : ch
        ),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmMuted"));
    }
  },

  unmuteDM: async (channelId) => {
    const res = await dmApi.unmuteDM(channelId);
    if (res.success) {
      set((state) => ({
        channels: state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, is_muted: false } : ch
        ),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmUnmuted"));
    }
  },

  fetchDMSettings: async () => {
    const res = await dmApi.getDMSettings();
    if (res.success && res.data) {
      const pinnedSet = new Set(res.data.pinned_channel_ids ?? []);
      const mutedSet = new Set(res.data.muted_channel_ids ?? []);
      set((state) => ({
        channels: sortChannelsByActivity(
          state.channels.map((ch) => ({
            ...ch,
            is_pinned: pinnedSet.has(ch.id),
            is_muted: mutedSet.has(ch.id),
          }))
        ),
      }));
    }
  },

  setPendingSearchChannelId: (id) => set({ pendingSearchChannelId: id }),

  incrementDMUnread: (channelId) => {
    set((state) => ({
      dmUnreadCounts: {
        ...state.dmUnreadCounts,
        [channelId]: (state.dmUnreadCounts[channelId] ?? 0) + 1,
      },
    }));
  },

  decrementDMUnread: (channelId) => {
    set((state) => {
      const current = state.dmUnreadCounts[channelId] ?? 0;
      if (current <= 0) return state;

      if (current === 1) {
        const next = { ...state.dmUnreadCounts };
        delete next[channelId];
        return { dmUnreadCounts: next };
      }

      return {
        dmUnreadCounts: {
          ...state.dmUnreadCounts,
          [channelId]: current - 1,
        },
      };
    });
  },

  clearDMUnread: (channelId) => {
    const hadUnread = !!get().dmUnreadCounts[channelId];
    set((state) => {
      if (!state.dmUnreadCounts[channelId]) return state;
      const next = { ...state.dmUnreadCounts };
      delete next[channelId];
      return { dmUnreadCounts: next };
    });
    // Advance the server cursor only when something was actually unread —
    // every DM click lands here, and a no-op POST per click is wasted traffic.
    // Failure is silent: the local clear already happened and the next
    // fetchChannels re-seeds from the server's view.
    if (!hadUnread) return;
    const messages = get().messagesByChannel[channelId];
    const lastId = messages && messages.length > 0 ? messages[messages.length - 1].id : undefined;
    dmApi.markDMRead(channelId, lastId).catch(() => {});
  },

  handleDMReadSync: (data) => {
    set((state) => {
      if (typeof data.unread_count === "number" && data.unread_count > 0) {
        return { dmUnreadCounts: { ...state.dmUnreadCounts, [data.dm_channel_id]: data.unread_count } };
      }
      if (!state.dmUnreadCounts[data.dm_channel_id]) return state;
      const next = { ...state.dmUnreadCounts };
      delete next[data.dm_channel_id];
      return { dmUnreadCounts: next };
    });
  },

  getTotalDMUnread: () => {
    const { dmUnreadCounts, channels } = get();
    let total = 0;
    for (const [channelId, count] of Object.entries(dmUnreadCounts)) {
      const ch = channels.find((c) => c.id === channelId);
      if (ch?.is_muted) continue;
      total += count;
    }
    return total;
  },
});
