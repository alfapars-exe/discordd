import { create } from "zustand";
import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "./authStore";
import { useGameActivityStore } from "./gameActivityStore";
import { parseCS2SteamJoinRecipe, type CS2SteamJoinRecipe } from "../../../electron/cs2-join-contract";
import { isGameActivityId } from "../utils/gameActivity";
import { isGameActivitySourceBlocked, subscribeGameActivityMutations } from "../utils/gameActivityMutation";

export type GameJoinOfferState = { request_id: string; accepted: boolean; offer_revision: number; expires_at?: string; reason?: string };
type State = {
  sendWS: ((op: string, data: unknown) => void) | null;
  ownerId: string | null; generation: number; pendingId: string | null; offerRevision: number;
  state: GameJoinOfferState | null; sourceGameId: string | null; pendingActive: boolean;
  register: (sender: State["sendWS"]) => void;
  offer: (sourceGameId: string, recipe: CS2SteamJoinRecipe | null) => boolean;
  acknowledge: (value: GameJoinOfferState) => void;
};
export const useGameJoinStore = create<State>((set, get) => ({
  sendWS: null, ownerId: null, generation: -1, pendingId: null, offerRevision: 0, state: null, sourceGameId: null, pendingActive: false,
  register: sendWS => set({ sendWS, ownerId: useAuthStore.getState().user?.id ?? null, generation: getAuthGeneration(), pendingId: null, offerRevision: 0, state: null, sourceGameId: null, pendingActive: false }),
  offer: (sourceGameId, recipe) => {
    const state = get(), activity = useGameActivityStore.getState();
    if (!isGameActivityId(sourceGameId) || isGameActivitySourceBlocked(sourceGameId) || (recipe !== null && !parseCS2SteamJoinRecipe(recipe))) return false;
    if (!state.sendWS || !state.ownerId || state.ownerId !== useAuthStore.getState().user?.id || state.generation !== getAuthGeneration()
      || activity.ownerId !== state.ownerId || activity.authGeneration !== state.generation || !activity.epoch) return false;
    const requestId = crypto.randomUUID(), revision = state.offerRevision + 1;
    set({ pendingId: requestId, offerRevision: revision, state: null, sourceGameId, pendingActive: recipe !== null });
    state.sendWS("game_join_offer", { request_id: requestId, activity_epoch: activity.epoch, source_game_id: sourceGameId,
      canonical_game_id: "steam:730", offer_revision: revision, recipe });
    window.setTimeout(() => {
      if (get().pendingId === requestId) set({ pendingId: null, state: { request_id: requestId, accepted: false, offer_revision: revision, reason: "timeout" } });
    }, 8_000);
    return true;
  },
  acknowledge: value => {
    const state = get();
    if (state.ownerId !== useAuthStore.getState().user?.id || state.generation !== getAuthGeneration()
      || !value || value.request_id !== state.pendingId || typeof value.accepted !== "boolean"
      || !Number.isSafeInteger(value.offer_revision) || value.offer_revision < 0) return;
    if (value.accepted && state.pendingActive) {
      const expiry = Date.parse(value.expires_at ?? "");
      if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 91_000) return;
    }
    set({ pendingId: null, state: value });
  },
}));
subscribeGameActivityMutations((sourceId, blocked) => {
  if (blocked && useGameJoinStore.getState().sourceGameId === sourceId) useGameJoinStore.setState({ pendingId: null, state: null });
});
