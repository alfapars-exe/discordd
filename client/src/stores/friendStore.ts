/**
 * Friend Store — Friendship system state management.
 *
 * Stable empty refs (EMPTY_*) prevent infinite re-renders in selectors.
 */

import { create } from "zustand";
import * as friendsApi from "../api/friends";
import type { FriendshipWithUser, UserStatus } from "../types";
import {useBlockStore} from "./blockStore";
import {useAuthStore} from "./authStore";
import {getAuthGeneration} from "../api/client";

const EMPTY_FRIENDS: FriendshipWithUser[] = [];
const EMPTY_INCOMING: FriendshipWithUser[] = [];
const EMPTY_OUTGOING: FriendshipWithUser[] = [];
let relationshipRevision=0,friendRead=0,requestRead=0;
function friendSessionGuard(){
  const owner=useAuthStore.getState().user?.id,generation=getAuthGeneration();
  return ()=>Boolean(owner)&&owner===useAuthStore.getState().user?.id&&generation===getAuthGeneration();
}

export type SendFriendRequestResult = {
  success: boolean;
  error?: string;
  /** On success: the created (or mutually auto-accepted) row — `user_id` is the TARGET. */
  friendship?: FriendshipWithUser;
};

type FriendState = {
  friends: FriendshipWithUser[];
  incoming: FriendshipWithUser[];
  outgoing: FriendshipWithUser[];
  isLoading: boolean;

  // ─── Actions ───
  fetchFriends: () => Promise<void>;
  fetchRequests: () => Promise<void>;
  sendRequest: (username: string) => Promise<SendFriendRequestResult>;
  acceptRequest: (requestId: string) => Promise<boolean>;
  declineRequest: (requestId: string) => Promise<boolean>;
  removeFriend: (userId: string) => Promise<boolean>;

  // ─── WS Event Handlers ───
  handleFriendRequestCreate: (data: FriendshipWithUser) => void;
  handleFriendRequestAccept: (data: FriendshipWithUser) => void;
  handleFriendRequestDecline: (data: { id: string; user_id: string }) => void;
  handleFriendRemove: (data: { user_id: string }) => void;
  /** WS presence_update (via presenceStore) — refresh `user_status` on every row for that user. */
  handlePresenceUpdate: (userId: string, status: UserStatus) => void;
};

export const useFriendStore = create<FriendState>((set, get) => ({
  friends: EMPTY_FRIENDS,
  incoming: EMPTY_INCOMING,
  outgoing: EMPTY_OUTGOING,
  isLoading: false,

  // ─── Actions ───

  fetchFriends: async () => {
    const current=friendSessionGuard(),revision=relationshipRevision,request=++friendRead;
    if(!current())return;
    set({ isLoading: true });
    try {
      const res = await friendsApi.listFriends({expectedUserId:useAuthStore.getState().user?.id,isCurrent:current});
      if (current()&&revision===relationshipRevision&&request===friendRead&&res.success && res.data) {
        set({ friends: res.data.filter(row=>!useBlockStore.getState().isBlocked(row.user_id)) });
      }
    } catch {
      // Keep the last confirmed list when a refresh fails.
    } finally {
      if(current()&&request===friendRead)set({ isLoading: false });
    }
  },

  fetchRequests: async () => {
    const current=friendSessionGuard(),revision=relationshipRevision,request=++requestRead;
    if(!current())return;
    try {
      const res = await friendsApi.listRequests({expectedUserId:useAuthStore.getState().user?.id,isCurrent:current});
      if (current()&&revision===relationshipRevision&&request===requestRead&&res.success && res.data) {
        set({
          incoming: res.data.incoming.filter(row=>!useBlockStore.getState().isBlocked(row.user_id)),
          outgoing: res.data.outgoing.filter(row=>!useBlockStore.getState().isBlocked(row.user_id)),
        });
      }
    } catch {
      // Silent — toast is handler's responsibility
    }
  },

  sendRequest: async (username: string) => {
    const current=friendSessionGuard(),revision=relationshipRevision;
    if(!current())return {success:false,error:"request_cancelled"};
    const res = await friendsApi.sendRequest(username,{expectedUserId:useAuthStore.getState().user?.id,isCurrent:current});
    if(!current())return {success:false,error:"request_cancelled"};
    if (res.success && res.data) {
      if(useBlockStore.getState().isBlocked(res.data.user_id))return {success:false,error:"user_blocked"};
      if(revision!==relationshipRevision){
        await Promise.all([get().fetchFriends(),get().fetchRequests()]);
        if(!current())return {success:false,error:"request_cancelled"};
        const confirmed=[...get().friends,...get().outgoing].find(row=>row.id===res.data!.id);
        return confirmed?{success:true,friendship:confirmed}:{success:false,error:"relationship_changed"};
      }
      ++relationshipRevision;
      if (res.data.status === "accepted") {
        set((s) => ({ friends: [res.data!, ...s.friends] }));
      } else {
        set((s) => ({ outgoing: [res.data!, ...s.outgoing] }));
      }
      return { success: true, friendship: res.data };
    }
    return { success: false, error: res.error };
  },

  acceptRequest: async (requestId: string) => {
    const current=friendSessionGuard(),revision=relationshipRevision;
    if(!current())return false;
    const res = await friendsApi.acceptRequest(requestId,{expectedUserId:useAuthStore.getState().user?.id,isCurrent:current});
    if(!current())return false;
    if (res.success && res.data) {
      if(useBlockStore.getState().isBlocked(res.data.user_id))return false;
      if(revision!==relationshipRevision){
        await Promise.all([get().fetchFriends(),get().fetchRequests()]);
        return current()&&get().friends.some(row=>row.id===res.data!.id);
      }
      ++relationshipRevision;
      set((s) => ({
        incoming: s.incoming.filter((r) => r.id !== requestId),
        friends: [res.data!, ...s.friends],
      }));
      return true;
    }
    return false;
  },

  declineRequest: async (requestId: string) => {
    const current=friendSessionGuard();if(!current())return false;
    const res = await friendsApi.declineRequest(requestId,{expectedUserId:useAuthStore.getState().user?.id,isCurrent:current});
    if(!current())return false;
    if (res.success) {
      ++relationshipRevision;
      set((s) => ({
        // Remove from both lists (user could be on either side)
        incoming: s.incoming.filter((r) => r.id !== requestId),
        outgoing: s.outgoing.filter((r) => r.id !== requestId),
      }));
      return true;
    }
    return false;
  },

  removeFriend: async (userId: string) => {
    const current=friendSessionGuard(),revision=relationshipRevision;if(!current())return false;
    const res = await friendsApi.removeFriend(userId,{expectedUserId:useAuthStore.getState().user?.id,isCurrent:current});
    if(!current())return false;
    if (res.success) {
      if(revision!==relationshipRevision){await get().fetchFriends();return current()&&!get().friends.some(row=>row.user_id===userId);}
      ++relationshipRevision;
      set((s) => ({
        friends: s.friends.filter((f) => f.user_id !== userId),
      }));
      return true;
    }
    return false;
  },

  // ─── WS Event Handlers ───

  handleFriendRequestCreate: (data: FriendshipWithUser) => {
    if(useBlockStore.getState().isBlocked(data.user_id))return;
    ++relationshipRevision;
    set((s) => ({
      incoming: [data, ...s.incoming],
    }));
  },

  handleFriendRequestAccept: (data: FriendshipWithUser) => {
    if(useBlockStore.getState().isBlocked(data.user_id))return;
    ++relationshipRevision;
    // A late event may describe a friendship already removed by a reverse
    // block. Fetch canonical lists instead of resurrecting event payloads.
    void get().fetchFriends();
    void get().fetchRequests();
  },

  handleFriendRequestDecline: (data: { id: string; user_id: string }) => {
    ++relationshipRevision;
    set((s) => ({
      incoming: s.incoming.filter((r) => r.id !== data.id),
      outgoing: s.outgoing.filter((r) => r.id !== data.id),
    }));
  },

  handleFriendRemove: (data: { user_id: string }) => {
    ++relationshipRevision;
    set((s) => ({
      friends: s.friends.filter((f) => f.user_id !== data.user_id),
      incoming: s.incoming.filter((f) => f.user_id !== data.user_id),
      outgoing: s.outgoing.filter((f) => f.user_id !== data.user_id),
    }));
  },

  handlePresenceUpdate: (userId, status) => {
    set((s) => {
      const patch = (list: FriendshipWithUser[]) =>
        list.some((f) => f.user_id === userId && f.user_status !== status)
          ? list.map((f) => (f.user_id === userId ? { ...f, user_status: status } : f))
          : list;
      const friends = patch(s.friends);
      const incoming = patch(s.incoming);
      const outgoing = patch(s.outgoing);
      // No row for this user (or nothing changed) — keep the same reference
      // so selectors don't re-render.
      if (friends === s.friends && incoming === s.incoming && outgoing === s.outgoing) return s;
      return { friends, incoming, outgoing };
    });
  },
}));
