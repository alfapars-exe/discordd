import { create } from "zustand";
import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "./authStore";
import { isGameActivityId as safeId, isGameActivityName } from "../utils/gameActivity";

export type SharedGame = { id: string; name: string; started_at: string; canonical_game_id?: "steam:730" };
export type GameActivityUpdate = { epoch: string; user_id: string; server_id?: string; game: SharedGame | null; revision: number; transition?: boolean };
type Entry = { revision: number; game: SharedGame | null; transition?: true };
const keyFor = (userId: string, serverId = "") => JSON.stringify([userId, serverId]);

type State = {
  ownerId: string | null;
  authGeneration: number;
  epoch: string | null;
  entries: Record<string, Entry>;
  start: (epoch?: string) => void;
  clear: () => void;
  apply: (update: GameActivityUpdate) => void;
};

export const useGameActivityStore = create<State>((set, get) => ({
  ownerId: null, authGeneration: -1, epoch: null, entries: {},
  start: (epoch) => set({ ownerId: useAuthStore.getState().user?.id ?? null, authGeneration: getAuthGeneration(), epoch: epoch && epoch.length <= 256 ? epoch : null, entries: {} }),
  clear: () => set({ ownerId: null, authGeneration: -1, epoch: null, entries: {} }),
  apply: (update) => {
    const state = get();
    if (!state.ownerId || state.ownerId !== useAuthStore.getState().user?.id || state.authGeneration !== getAuthGeneration()) return;
    if (!state.epoch || update?.epoch !== state.epoch) return;
    if (!update || !safeId(update.user_id) || (update.server_id !== undefined && update.server_id !== "" && !safeId(update.server_id))
      || !Number.isSafeInteger(update.revision) || update.revision < 1 || (update.transition !== undefined && typeof update.transition !== "boolean")) return;
    const game = update.game;
    if (game !== null && (!game || !safeId(game.id) || !isGameActivityName(game.name)
      || typeof game.started_at !== "string" || !Number.isFinite(Date.parse(game.started_at))
      || (game.canonical_game_id !== undefined && game.canonical_game_id !== "steam:730"))) return;
    const key = keyFor(update.user_id, update.server_id);
    if ((state.entries[key]?.revision ?? 0) >= update.revision) return;
    // Retain null revisions as tombstones: a delayed grant cannot undo revocation.
    if (!state.entries[key] && Object.keys(state.entries).length >= 10_000) return;
    set({ entries: { ...state.entries, [key]: { revision: update.revision, ...(update.transition === true && game && !update.server_id ? { transition: true as const } : {}), game: game ? { id: game.id, name: game.name, started_at: game.started_at,
      ...(game.canonical_game_id === "steam:730" ? { canonical_game_id: "steam:730" as const } : {}),
    } : null } } });
  },
}));

export function gameActivityKey(userId: string, serverId?: string): string { return keyFor(userId, serverId); }
