/**
 * Presence Store — live status overlay for users outside the member lists.
 *
 * memberStore only tracks presence for users who appear in a cached server
 * roster. DM partners and friends are not necessarily server members, so
 * their `status` / `user_status` would stay frozen at whatever GET /api/dms
 * and GET /api/friends returned. This store keeps a user-id → status overlay
 * fed by `presence_update`, and forwards each update to friendStore so the
 * friend rows stay live too.
 */

import { create } from "zustand";
import { useFriendStore } from "./friendStore";
import type { UserStatus } from "../types";

type PresenceState = {
  statusByUserId: Record<string, UserStatus>;
  /** WS `ready` — clears the overlay; the ready-triggered refetches bring fresh DB state. */
  handleReady: (onlineIds: string[]) => void;
  /** WS `presence_update` — records the status and pushes it into friendStore rows. */
  handlePresenceUpdate: (userId: string, status: UserStatus) => void;
};

export const usePresenceStore = create<PresenceState>((set) => ({
  statusByUserId: {},

  handleReady: () => {
    set({ statusByUserId: {} });
  },

  handlePresenceUpdate: (userId, status) => {
    set((state) => ({
      statusByUserId: { ...state.statusByUserId, [userId]: status },
    }));
    useFriendStore.getState().handlePresenceUpdate(userId, status);
  },
}));

/** Status dot colour — same map as the friends sidebar (FriendsSection). */
export function presenceDotColor(status: UserStatus): string {
  switch (status) {
    case "online":
      return "var(--green)";
    case "idle":
      return "var(--yellow, #f0b232)";
    case "dnd":
      return "var(--red)";
    default:
      return "var(--t3)";
  }
}
