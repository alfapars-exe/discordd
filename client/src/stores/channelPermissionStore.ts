/**
 * Channel Permission Store — Per-channel permission override management.
 *
 * Data structure: Record<channelId, ChannelPermissionOverride[]>
 * Overrides are fetched on first access and cached.
 */

import { create } from "zustand";
import { getAuthGeneration } from "../api/client";
import { getAuthSessionOwner, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import * as channelPermApi from "../api/channelPermissions";
import { useServerStore } from "./serverStore";
import type { ChannelPermissionOverride } from "../types";

/** Stable empty ref for selectors */
const EMPTY_OVERRIDES: ChannelPermissionOverride[] = [];

export type OverrideLoadStatus = "ready" | "loading" | "error" | "unavailable";
export type ChannelOverrideLoad = {
  serverId: string;
  ownerId: string;
  authGeneration: number;
  status: Exclude<OverrideLoadStatus, "unavailable">;
};

type OverrideRequest = {
  serverId: string;
  ownerId: string;
  authGeneration: number;
  promise: Promise<void>;
};

const inflight = new Map<string, OverrideRequest>();
let currentOwnerId = getAuthSessionOwner();
let observedAuthGeneration = getAuthGeneration();

function identity() {
  return {
    ownerId: currentOwnerId,
    authGeneration: getAuthGeneration(),
  };
}

function sameScope(entry: ChannelOverrideLoad | undefined, serverId: string, ownerId: string, authGeneration: number) {
  return Boolean(entry && entry.serverId === serverId && entry.ownerId === ownerId && entry.authGeneration === authGeneration);
}

function resetPermissionCache() {
  // Dropping the request records fences late responses without needing to
  // cancel the transport. The response path also checks auth generation.
  inflight.clear();
  useChannelPermissionStore.setState({ overridesByChannel: {}, fetchedChannels: new Set(), statusByChannel: {} });
}

subscribeAuthOwnerChanges((ownerId) => {
  if (ownerId === currentOwnerId) return;
  currentOwnerId = ownerId;
  resetPermissionCache();
});
observedAuthGeneration = getAuthGeneration();

// Token installation/clearing advances auth generation before authStore
// publishes its next user. Clear synchronously so same-user reauth cannot
// temporarily reuse overrides from the prior session.
subscribeAuthGenerationChanges((generation) => {
  if (generation === observedAuthGeneration) return;
  observedAuthGeneration = generation;
  resetPermissionCache();
});

type ChannelPermissionState = {
  overridesByChannel: Record<string, ChannelPermissionOverride[]>;
  /** Tracks which channels have been fetched (prevents duplicate requests) */
  fetchedChannels: Set<string>;
  /** Freshness metadata for permission-sensitive surfaces; never infer ready from an empty override list. */
  statusByChannel: Record<string, ChannelOverrideLoad>;

  // ─── Actions ───
  fetchOverrides: (channelID: string, serverId?: string) => Promise<void>;
  setOverride: (channelID: string, roleID: string, allow: number, deny: number, serverId?: string) => Promise<boolean>;
  deleteOverride: (channelID: string, roleID: string, serverId?: string) => Promise<boolean>;
  getOverrides: (channelID: string) => ChannelPermissionOverride[];
  getOverrideStatus: (channelID: string, serverId?: string) => OverrideLoadStatus;

  /** Batch-fetch overrides for multiple channels (skips already-fetched) */
  fetchOverridesForChannels: (channelIDs: string[]) => void;

  // ─── WS Event Handlers ───
  handleOverrideUpdate: (override: ChannelPermissionOverride) => void;
  handleOverrideDelete: (channelID: string, roleID: string) => void;
};

export const useChannelPermissionStore = create<ChannelPermissionState>(
  (set, get) => ({
    overridesByChannel: {},
    fetchedChannels: new Set(),
    statusByChannel: {},

    fetchOverrides: async (channelID, explicitServerId?) => {
      const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
      const { ownerId, authGeneration } = identity();
      if (!serverId || !ownerId) {
        set((state) => {
          const { [channelID]: _removed, ...overridesByChannel } = state.overridesByChannel;
          const { [channelID]: _status, ...statusByChannel } = state.statusByChannel;
          const fetchedChannels = new Set(state.fetchedChannels);
          fetchedChannels.delete(channelID);
          return { overridesByChannel, statusByChannel, fetchedChannels };
        });
        return;
      }

      const currentStatus = get().statusByChannel[channelID];
      if (sameScope(currentStatus, serverId, ownerId, authGeneration) && currentStatus.status === "ready") return;
      const existing = inflight.get(channelID);
      if (existing && existing.serverId === serverId && existing.ownerId === ownerId && existing.authGeneration === authGeneration) {
        return existing.promise;
      }

      const request: OverrideRequest = { serverId, ownerId, authGeneration, promise: Promise.resolve() };
      set((state) => {
        const scopeChanged = !sameScope(state.statusByChannel[channelID], serverId, ownerId, authGeneration);
        const overridesByChannel = { ...state.overridesByChannel };
        if (scopeChanged) delete overridesByChannel[channelID];
        const fetchedChannels = new Set(state.fetchedChannels);
        fetchedChannels.delete(channelID);
        return {
          overridesByChannel,
          fetchedChannels,
          statusByChannel: {
            ...state.statusByChannel,
            [channelID]: { serverId, ownerId, authGeneration, status: "loading" },
          },
        };
      });

      request.promise = (async () => {
        try {
          const res = await channelPermApi.getOverrides(serverId, channelID);
          const currentIdentity = identity();
          const isCurrent = inflight.get(channelID) === request
            && currentIdentity.ownerId === ownerId
            && currentIdentity.authGeneration === authGeneration
            && (explicitServerId !== undefined || useServerStore.getState().activeServerId === serverId);
          if (!isCurrent) return;
          inflight.delete(channelID);
          if (res.success && Array.isArray(res.data)) {
            set((state) => ({
              overridesByChannel: { ...state.overridesByChannel, [channelID]: res.data! },
              fetchedChannels: new Set([...state.fetchedChannels, channelID]),
              statusByChannel: { ...state.statusByChannel, [channelID]: { serverId, ownerId, authGeneration, status: "ready" } },
            }));
          } else {
            set((state) => ({
              statusByChannel: { ...state.statusByChannel, [channelID]: { serverId, ownerId, authGeneration, status: "error" } },
            }));
          }
        } catch {
          const currentIdentity = identity();
          if (inflight.get(channelID) !== request || currentIdentity.ownerId !== ownerId || currentIdentity.authGeneration !== authGeneration) return;
          inflight.delete(channelID);
          set((state) => ({
            statusByChannel: { ...state.statusByChannel, [channelID]: { serverId, ownerId, authGeneration, status: "error" } },
          }));
        }
      })();
      inflight.set(channelID, request);
      return request.promise;
    },

    setOverride: async (channelID, roleID, allow, deny, explicitServerId?) => {
      const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
      if (!serverId) return false;
      const res = await channelPermApi.setOverride(
        serverId,
        channelID,
        roleID,
        allow,
        deny
      );
      // State updated via WS broadcast (handleOverrideUpdate)
      return !!res.data;
    },

    deleteOverride: async (channelID, roleID, explicitServerId?) => {
      const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
      if (!serverId) return false;
      const res = await channelPermApi.deleteOverride(serverId, channelID, roleID);
      return !!res.data;
    },

    getOverrides: (channelID) => {
      return get().overridesByChannel[channelID] ?? EMPTY_OVERRIDES;
    },

    getOverrideStatus: (channelID, explicitServerId?) => {
      const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
      const { ownerId, authGeneration } = identity();
      if (!serverId || !ownerId) return "unavailable";
      const entry = get().statusByChannel[channelID];
      if (!sameScope(entry, serverId, ownerId, authGeneration)) return "unavailable";
      return entry.status;
    },

    fetchOverridesForChannels: (channelIDs) => {
      const { fetchedChannels, fetchOverrides, getOverrideStatus } = get();
      for (const id of channelIDs) {
        if (!fetchedChannels.has(id) || getOverrideStatus(id) !== "ready") {
          fetchOverrides(id);
        }
      }
    },

    // ─── WS Event Handlers ───

    handleOverrideUpdate: (override) => {
      set((state) => {
        const existing = state.overridesByChannel[override.channel_id] ?? [];
        // Upsert: update existing or append new
        const found = existing.some((o) => o.role_id === override.role_id);
        const updated = found
          ? existing.map((o) =>
              o.role_id === override.role_id ? override : o
            )
          : [...existing, override];

        return {
          overridesByChannel: {
            ...state.overridesByChannel,
            [override.channel_id]: updated,
          },
        };
      });

    },

    handleOverrideDelete: (channelID, roleID) => {
      set((state) => {
        const existing = state.overridesByChannel[channelID];
        if (!existing) return state;

        return {
          overridesByChannel: {
            ...state.overridesByChannel,
            [channelID]: existing.filter((o) => o.role_id !== roleID),
          },
        };
      });
    },
  })
);
