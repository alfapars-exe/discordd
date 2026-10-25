/**
 * Invite Store — Invite code management.
 */

import { create } from "zustand";
import * as inviteApi from "../api/invites";
import type { Invite } from "../types";

/** Stable empty ref for selectors */
const EMPTY_INVITES: Invite[] = [];
let visibleRequest = 0;
let resetVersion = 0;
const permanentRequests = new Map<string, Promise<Invite | null>>();
const shareRequests = new Map<string, Promise<Invite | null>>();
const SEVEN_DAYS_MINUTES = 7 * 24 * 60;

type InviteState = {
  invites: Invite[];
  isLoading: boolean;
  /** Which server the current invites belong to */
  _loadedServerId: string | null;

  fetchInvites: (serverId: string) => Promise<Invite[] | null>;
  createInvite: (serverId: string, maxUses: number, expiresIn: number, channelId?: string) => Promise<Invite | null>;
  /** Get existing permanent invite or create one. Used by "Copy Invite Link" flows. */
  getOrCreatePermanentInvite: (serverId: string) => Promise<Invite | null>;
  /** Default user-facing share link: unlimited uses, expires after seven days. */
  getOrCreateShareInvite: (serverId: string, channelId?: string) => Promise<Invite | null>;
  deleteInvite: (serverId: string, code: string) => Promise<boolean>;
  clearForServerSwitch: () => void;
};

export const useInviteStore = create<InviteState>((set, get) => ({
  invites: EMPTY_INVITES,
  isLoading: false,
  _loadedServerId: null,

  fetchInvites: async (serverId: string) => {
    const request = ++visibleRequest;
    const version = resetVersion;
    set((state) => ({
      isLoading: true, _loadedServerId: serverId,
      invites: state._loadedServerId === serverId ? state.invites : EMPTY_INVITES,
    }));
    try {
      const res = await inviteApi.getInvites(serverId);
      if (version !== resetVersion) return null;
      const invites = res.success && res.data ? res.data : null;
      if (request === visibleRequest) {
        set({ invites: invites ?? EMPTY_INVITES, isLoading: false });
      }
      // Return THIS request's server data, never the mutable visible slice.
      return invites;
    } catch {
      if (request === visibleRequest) set({ isLoading: false, invites: EMPTY_INVITES });
      return null;
    }
  },

  createInvite: async (serverId: string, maxUses: number, expiresIn: number, channelId?: string) => {
    const version = resetVersion;
    try {
      const res = await inviteApi.createInvite(serverId, {
        max_uses: maxUses,
        expires_in: expiresIn,
        channel_id: channelId,
      });
      if (version !== resetVersion) return null;
      if (res.success && res.data) {
        // Refresh creator info only if this server is still the visible one.
        // Finishing an old modal's creation must not replace another server's list.
        if (get()._loadedServerId === serverId) await get().fetchInvites(serverId);
        return version === resetVersion ? res.data : null;
      }
    } catch {
      return null;
    }
    return null;
  },

  getOrCreatePermanentInvite: (serverId: string) => {
    const inFlight = permanentRequests.get(serverId);
    if (inFlight) return inFlight;
    const version = resetVersion;
    const pending = (async () => {
      const state = get();
      const invites = state._loadedServerId === serverId && state.invites.length > 0
        ? state.invites : await get().fetchInvites(serverId);
      // A failed/unauthorized lookup must not reuse another server's link or
      // silently turn into a create request.
      if (!invites || version !== resetVersion) return null;
      const existing = invites.find((invite) => invite.max_uses === 0 && invite.expires_at === null);
      return existing ?? get().createInvite(serverId, 0, 0);
    })();
    permanentRequests.set(serverId, pending);
    void pending.finally(() => {
      if (permanentRequests.get(serverId) === pending) permanentRequests.delete(serverId);
    });
    return pending;
  },

  getOrCreateShareInvite: (serverId: string, channelId?: string) => {
	const requestKey = `${serverId}:${channelId ?? "server"}`;
	const inFlight = shareRequests.get(requestKey);
    if (inFlight) return inFlight;
    const version = resetVersion;
    const pending = (async () => {
      const state = get();
      const invites = state._loadedServerId === serverId && state.invites.length > 0
        ? state.invites : await get().fetchInvites(serverId);
      if (!invites || version !== resetVersion) return null;
      const now = Date.now();
      const targeted = invites.find((invite) => (invite.channel_id ?? null) === (channelId ?? null) && invite.max_uses === 0 && !!invite.expires_at && Date.parse(invite.expires_at) > now && Math.abs((Date.parse(invite.expires_at) - Date.parse(invite.created_at)) / 60000 - SEVEN_DAYS_MINUTES) < 2);
      return targeted ?? get().createInvite(serverId, 0, SEVEN_DAYS_MINUTES, channelId);
    })();
    shareRequests.set(requestKey, pending);
    void pending.finally(() => {
      if (shareRequests.get(requestKey) === pending) shareRequests.delete(requestKey);
    });
    return pending;
  },

  deleteInvite: async (serverId: string, code: string) => {
    const res = await inviteApi.deleteInvite(serverId, code);

    if (res.success) {
      if (get()._loadedServerId === serverId) {
        ++visibleRequest;
        set((state) => ({ invites: state.invites.filter((inv) => inv.code !== code), isLoading: false }));
      }
      return true;
    }

    return false;
  },

  clearForServerSwitch: () => {
    ++visibleRequest;
    ++resetVersion;
    permanentRequests.clear();
    shareRequests.clear();
    set({ invites: EMPTY_INVITES, _loadedServerId: null, isLoading: false });
  },
}));
