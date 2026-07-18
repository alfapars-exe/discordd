/**
 * Channel Store — Channel and category state management.
 */

import { create } from "zustand";
import * as channelApi from "../api/channels";
import { useServerStore } from "./serverStore";
import type {
  Channel,
  Category,
  CategoryWithChannels,
} from "../types";

type ChannelState = {
  categories: CategoryWithChannels[];
  /**
   * Per-server channel-tree cache. Lets a re-visited server paint instantly
   * from the last-known tree while a background fetch revalidates. Keyed by
   * serverId; entries are dropped by evictServerCache when a server is left
   * or deleted so this can't grow unbounded. Values are typed as
   * `T | undefined` — noUncheckedIndexedAccess plus `delete` semantics both
   * expose the undefined branch, and every consumer already handles it.
   */
  categoriesByServer: Record<string, CategoryWithChannels[] | undefined>;
  selectedChannelId: string | null;
  isLoading: boolean;
  mutedChannelIds: Set<string>;

  // ─── Actions ───
  fetchChannels: () => Promise<void>;
  selectChannel: (channelId: string) => void;
  /** Snapshot outgoing server's tree, then paint incoming from cache. */
  switchToServer: (serverId: string | null) => void;
  /** Paint current activeServer from cache — used when setActiveServer was
   *  bypassed (route change, cascadeRefetch flow). */
  hydrateFromCache: () => void;
  /** Drop a server's cached tree — call after leave/delete. */
  evictServerCache: (serverId: string) => void;

  // ─── Channel Mute ───
  setMutedChannelsFromReady: (ids: string[]) => void;
  muteChannel: (channelId: string, duration: string) => Promise<boolean>;
  unmuteChannel: (channelId: string) => Promise<boolean>;

  // ─── WS Event Handlers ───
  handleChannelCreate: (channel: Channel) => void;
  handleChannelUpdate: (channel: Channel) => void;
  handleChannelDelete: (channelId: string) => void;
  handleCategoryCreate: (category: Category) => void;
  handleCategoryUpdate: (category: Category) => void;
  handleCategoryDelete: (categoryId: string) => void;

  // ─── Reorder ───
  reorderChannels: (items: { id: string; position: number; category_id?: string }[]) => Promise<boolean>;
  reorderCategories: (items: { id: string; position: number }[]) => Promise<boolean>;
  handleChannelReorder: (categories: CategoryWithChannels[]) => void;
  handleCategoryReorder: () => void;

  clearForServerSwitch: () => void;
};

export const useChannelStore = create<ChannelState>((set, get) => ({
  categories: [],
  categoriesByServer: {},
  selectedChannelId: null,
  isLoading: false,
  mutedChannelIds: new Set<string>(),

  fetchChannels: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    // Only show the loading state if we don't already have cached data to
    // paint — otherwise the user sees a spinner briefly before the cached
    // tree pops in, which is jarring for a revalidation.
    const cached = get().categoriesByServer[serverId];
    if (!cached) set({ isLoading: true });

    const res = await channelApi.getChannels(serverId);
    if (res.success && res.data) {
      // Always update the cache — even if the user has already switched to
      // another server by the time the response arrives. Next time they come
      // back the freshest tree paints instantly.
      set((state) => ({
        categoriesByServer: {
          ...state.categoriesByServer,
          [serverId]: res.data,
        },
      }));

      // Guard against a stale response clobbering the live categories.
      // If the user switched away mid-flight, activeServerId has moved on
      // — writing to `categories` now would paint the wrong server's tree.
      const activeNow = useServerStore.getState().activeServerId;
      if (activeNow !== serverId) return;

      const state = get();
      let selectedChannelId = state.selectedChannelId;

      const allVisible = res.data.flatMap((cg) => cg.channels);

      // Drop the selection if the channel is no longer visible (deleted,
      // permission revoked, etc.). DO NOT auto-pick a "first text channel"
      // — that was disorienting on server switch because users found
      // themselves looking at a channel they didn't choose, sometimes
      // marking it read by accident. The empty state is fine: users land
      // on the welcome panel and pick a channel deliberately.
      if (selectedChannelId && !allVisible.some((ch) => ch.id === selectedChannelId)) {
        selectedChannelId = null;
      }

      set({ categories: res.data, isLoading: false, selectedChannelId });
    } else {
      set({ isLoading: false });
    }
  },

  selectChannel: (channelId) => {
    set({ selectedChannelId: channelId });
  },

  switchToServer: (nextServerId) => {
    set((state) => {
      const prevServerId = useServerStore.getState().activeServerId;
      const cacheUpdates: Record<string, CategoryWithChannels[]> = {};

      // Snapshot the outgoing server's tree so a return trip paints
      // instantly. Skip when categories is empty (nothing meaningful to
      // remember) or when the prev server is the one we're switching to
      // (setActiveServer no-op).
      if (prevServerId && prevServerId !== nextServerId && state.categories.length > 0) {
        cacheUpdates[prevServerId] = state.categories;
      }

      const cached = nextServerId ? state.categoriesByServer[nextServerId] : undefined;
      return {
        categoriesByServer: { ...state.categoriesByServer, ...cacheUpdates },
        categories: cached ?? [],
        selectedChannelId: null,
        // Cached hit → skip the loading state entirely.
        isLoading: !cached && nextServerId != null,
      };
    });
  },

  hydrateFromCache: () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const cached = get().categoriesByServer[serverId];
    if (!cached) return;
    set({ categories: cached, isLoading: false });
  },

  evictServerCache: (serverId) => {
    set((state) => {
      if (!(serverId in state.categoriesByServer)) return state;
      const next = { ...state.categoriesByServer };
      delete next[serverId];
      return { categoriesByServer: next };
    });
  },

  // ─── WebSocket Event Handlers ───

  handleChannelCreate: (channel) => {
    set((state) => {
      const targetCatId = channel.category_id ?? "";
      let found = false;

      const categories = state.categories.map((cg) => {
        if (cg.category.id === targetCatId) {
          found = true;
          return {
            ...cg,
            channels: [...cg.channels, channel],
          };
        }
        return cg;
      });

      // If target category not found, create virtual uncategorized group or fallback
      if (!found) {
        if (targetCatId === "") {
          categories.unshift({
            category: { id: "", name: "", position: -1 },
            channels: [channel],
          });
        } else if (categories.length > 0) {
          const first = { ...categories[0] };
          first.channels = [...first.channels, channel];
          categories[0] = first;
        }
      }

      return { categories };
    });
  },

  handleChannelUpdate: (channel) => {
    set((state) => ({
      categories: state.categories.map((cg) => ({
        ...cg,
        channels: cg.channels.map((ch) =>
          ch.id === channel.id ? channel : ch
        ),
      })),
    }));
  },

  handleChannelDelete: (channelId) => {
    set((state) => {
      const categories = state.categories.map((cg) => ({
        ...cg,
        channels: cg.channels.filter((ch) => ch.id !== channelId),
      }));

      let selectedChannelId = state.selectedChannelId;
      if (selectedChannelId === channelId) {
        const firstTextChannel = categories
          .flatMap((cg) => cg.channels)
          .find((ch) => ch.type === "text");
        selectedChannelId = firstTextChannel?.id ?? null;
      }

      return { categories, selectedChannelId };
    });
  },

  handleCategoryCreate: (category) => {
    set((state) => ({
      categories: [
        ...state.categories,
        { category, channels: [] },
      ],
    }));
  },

  handleCategoryUpdate: (category) => {
    set((state) => ({
      categories: state.categories.map((cg) =>
        cg.category.id === category.id
          ? { ...cg, category }
          : cg
      ),
    }));
  },

  handleCategoryDelete: (categoryId) => {
    set((state) => ({
      categories: state.categories.filter(
        (cg) => cg.category.id !== categoryId
      ),
    }));
  },

  // ─── Reorder ───

  reorderChannels: async (items) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const prevCategories = get().categories;

    // Check for cross-category moves
    const categoryChangeMap = new Map<string, string>();
    for (const item of items) {
      if (item.category_id !== undefined) {
        categoryChangeMap.set(item.id, item.category_id);
      }
    }
    const hasCategoryChange = categoryChangeMap.size > 0;

    // Optimistic update
    const positionMap = new Map(items.map((item) => [item.id, item.position]));

    if (hasCategoryChange) {
      set((state) => {
        const allChannels = state.categories.flatMap((cg) => cg.channels);

        const newCategories = state.categories.map((cg) => {
          const catId = cg.category.id;

          let channels = cg.channels.filter(
            (ch) => !categoryChangeMap.has(ch.id)
          );

          // Add channels moved to this category
          for (const [chId, targetCatId] of categoryChangeMap) {
            if (targetCatId === catId) {
              const ch = allChannels.find((c) => c.id === chId);
              if (ch) {
                channels.push({
                  ...ch,
                  category_id: targetCatId || null,
                });
              }
            }
          }

          channels = channels
            .map((ch) => {
              const newPos = positionMap.get(ch.id);
              return newPos !== undefined ? { ...ch, position: newPos } : ch;
            })
            .sort((a, b) => a.position - b.position);

          return { ...cg, channels };
        });

        return { categories: newCategories };
      });
    } else {
      // Same-category reorder
      set((state) => ({
        categories: state.categories.map((cg) => ({
          ...cg,
          channels: cg.channels
            .map((ch) => {
              const newPos = positionMap.get(ch.id);
              return newPos !== undefined ? { ...ch, position: newPos } : ch;
            })
            .sort((a, b) => a.position - b.position),
        })),
      }));
    }

    const res = await channelApi.reorderChannels(serverId, items);
    if (!res.success) {
      set({ categories: prevCategories });
      return false;
    }

    return true;
  },

  reorderCategories: async (items) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const prevCategories = get().categories;

    // Optimistic update
    const positionMap = new Map(items.map((item) => [item.id, item.position]));
    set((state) => ({
      categories: [...state.categories]
        .map((cg) => {
          const newPos = positionMap.get(cg.category.id);
          return newPos !== undefined
            ? { ...cg, category: { ...cg.category, position: newPos } }
            : cg;
        })
        .sort((a, b) => a.category.position - b.category.position),
    }));

    const res = await channelApi.reorderCategories(serverId, items);
    if (!res.success) {
      set({ categories: prevCategories });
      return false;
    }

    return true;
  },

  handleChannelReorder: (categories) => {
    set({ categories });
  },

  /** Re-fetch channels to get updated category order from server */
  handleCategoryReorder: () => {
    get().fetchChannels();
  },

  // ─── Channel Mute ───

  setMutedChannelsFromReady: (ids) => {
    set({ mutedChannelIds: new Set(ids) });
  },

  muteChannel: async (channelId, duration) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const res = await channelApi.muteChannel(serverId, channelId, duration);
    if (res.success) {
      set((state) => {
        const next = new Set(state.mutedChannelIds);
        next.add(channelId);
        return { mutedChannelIds: next };
      });
      return true;
    }
    return false;
  },

  unmuteChannel: async (channelId) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const res = await channelApi.unmuteChannel(serverId, channelId);
    if (res.success) {
      set((state) => {
        const next = new Set(state.mutedChannelIds);
        next.delete(channelId);
        return { mutedChannelIds: next };
      });
      return true;
    }
    return false;
  },

  clearForServerSwitch: () => {
    set({ categories: [], selectedChannelId: null, isLoading: false });
  },
}));
