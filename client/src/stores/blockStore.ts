/**
 * Block Store — User blocking state management.
 */

import { create } from "zustand";
import i18n from "../i18n";
import * as blockApi from "../api/block";
import { useToastStore } from "./toastStore";
import { useFriendStore } from "./friendStore";
import { useAuthStore } from "./authStore";
import type { FriendshipWithUser } from "../types";
import {getAuthGeneration} from "../api/client";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";

/** Stable empty ref to prevent infinite re-renders in selectors */
const EMPTY_BLOCKED: string[] = [];
let listRequest=0;
let blockRevision=0;
const pendingMutations=new Map<string,Promise<boolean>>();
function serializeBlockMutation(target:string,current:()=>boolean,operation:()=>Promise<boolean>):Promise<boolean>{
  const key=JSON.stringify([useAuthStore.getState().user?.id,getAuthGeneration(),target]);
  const previous=pendingMutations.get(key);
  const pending=(previous?previous.then(()=>current()?operation():false):operation()).catch(()=>false);
  pendingMutations.set(key,pending);
  void pending.then(()=>{if(pendingMutations.get(key)===pending)pendingMutations.delete(key);});
  return pending;
}
function sessionGuard(){
  const owner=useAuthStore.getState().user?.id,generation=getAuthGeneration();
  return ()=>Boolean(owner)&&owner===useAuthStore.getState().user?.id&&generation===getAuthGeneration();
}

type BlockState = {
  ownerId: string | null;
  authGeneration: number;
  snapshotReady: boolean;
  blockedUserIds: string[];
  isLoading: boolean;

  fetchBlocked: () => Promise<void>;
  blockUser: (userId: string) => Promise<boolean>;
  unblockUser: (userId: string) => Promise<boolean>;
  isBlocked: (userId: string) => boolean;

  // ─── WS Event Handlers ───
  handleUserBlock: (data: { user_id: string; blocked_user_id: string }) => void;
  handleUserUnblock: (data: { user_id: string; unblocked_user_id: string }) => void;
};

export const useBlockStore = create<BlockState>((set, get) => ({
  ownerId: getAuthSessionSnapshot().ownerId,
  authGeneration: getAuthSessionSnapshot().generation,
  snapshotReady: false,
  blockedUserIds: EMPTY_BLOCKED,
  isLoading: false,

  fetchBlocked: async () => {
    const current=sessionGuard(),request=++listRequest,revision=blockRevision;
    if(!current())return;
    const snapshot = getAuthSessionSnapshot();
    set({ isLoading: true, ownerId: snapshot.ownerId, authGeneration: snapshot.generation, snapshotReady: false });
    try {
      const res = await blockApi.listBlocked({expectedUserId:useAuthStore.getState().user?.id,isCurrent:current});
      if (current() && request===listRequest && revision===blockRevision && res.success && res.data) {
        set({ blockedUserIds: res.data.map((f: FriendshipWithUser) => f.user_id), snapshotReady: true });
      }
    } finally {
      if(current()&&request===listRequest)set({ isLoading: false });
    }
  },

  blockUser: async (userId) => {
    const current=sessionGuard();
    if(!current())return false;
    return serializeBlockMutation(userId,current,async()=>{
    ++blockRevision;
    const res = await blockApi.blockUser(userId,{expectedUserId:useAuthStore.getState().user?.id,isCurrent:current});
    if (current() && res.success) {
      ++blockRevision;
      set((s) => ({
        blockedUserIds: s.blockedUserIds.includes(userId) ? s.blockedUserIds : [...s.blockedUserIds, userId],
      }));
      // Backend already removes friendship
      useFriendStore.getState().handleFriendRemove({ user_id: userId });
      useToastStore.getState().addToast("success", i18n.t("dm:userBlocked"));
      return true;
    }
    return false;
    });
  },

  unblockUser: async (userId) => {
    const current=sessionGuard();
    if(!current())return false;
    return serializeBlockMutation(userId,current,async()=>{
    ++blockRevision;
    const res = await blockApi.unblockUser(userId,{expectedUserId:useAuthStore.getState().user?.id,isCurrent:current});
    if (current() && res.success) {
      ++blockRevision;
      set((s) => ({
        blockedUserIds: s.blockedUserIds.filter((id) => id !== userId),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:userUnblocked"));
      return true;
    }
    return false;
    });
  },

  isBlocked: (userId) => {
    return get().blockedUserIds.includes(userId);
  },

  // ─── WS Event Handlers ───

  /**
   * Backend broadcasts to both parties.
   * If we blocked: add to list + remove from friends.
   * If they blocked us: just remove from friends.
   */
  handleUserBlock: (data) => {
    const myId = useAuthStore.getState().user?.id;

    if (data.user_id === myId) {
      ++blockRevision;
      set((s) => {
        if (s.blockedUserIds.includes(data.blocked_user_id)) return s;
        return { blockedUserIds: [...s.blockedUserIds, data.blocked_user_id] };
      });
      useFriendStore.getState().handleFriendRemove({ user_id: data.blocked_user_id });
    } else if (data.blocked_user_id === myId) {
      useFriendStore.getState().handleFriendRemove({ user_id: data.user_id });
    }
  },

  handleUserUnblock: (data) => {
    const myId = useAuthStore.getState().user?.id;

    if (data.user_id === myId) {
      ++blockRevision;
      set((s) => {
        // Keep the same array reference when the id is already gone (e.g. the
        // optimistic unblock ran first) so subscribers don't refetch twice.
        if (!s.blockedUserIds.includes(data.unblocked_user_id)) return s;
        return {
          blockedUserIds: s.blockedUserIds.filter((id) => id !== data.unblocked_user_id),
        };
      });
    }
  },
}));

function resetBlockScope() {
  ++listRequest;
  ++blockRevision;
  const snapshot = getAuthSessionSnapshot();
  useBlockStore.setState({ ownerId: snapshot.ownerId, authGeneration: snapshot.generation, snapshotReady: false, blockedUserIds: EMPTY_BLOCKED, isLoading: false });
}
subscribeAuthOwnerChanges(resetBlockScope);
subscribeAuthGenerationChanges(resetBlockScope);
