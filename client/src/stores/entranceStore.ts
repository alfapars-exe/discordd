/**
 * entranceStore — the viewer's own entrance-sound library + selections (Faz E).
 *
 * Loaded lazily by the "Entrance Sound" settings tab (`load()`); every
 * mutation goes through the REST API and folds the server's answer back in.
 * There is no WS sync — the server is authoritative and nothing else needs
 * this cache. Server-level settings/mutes are not cached (the server tab and
 * the voice context menu fetch them on demand).
 *
 * Per-user cache → reset on logout (#226, authStore.logout). The generation
 * counter makes responses that land after a reset() no-ops.
 */

import { create } from "zustand";
import * as entranceApi from "../api/entrance";
import type { APIResponse } from "../types";
import type { EntranceSelection, EntranceSelectionInput, EntranceSound } from "../types/entrance";

export type EntranceLoadStatus = "idle" | "loading" | "ready" | "error";

/** Per-account clip cap (server enforces it atomically). */
export const MAX_ENTRANCE_CLIPS = 5;

type EntranceState = {
  sounds: EntranceSound[];
  selections: EntranceSelection[];
  status: EntranceLoadStatus;

  load: () => Promise<void>;
  upload: (blob: Blob, name: string) => Promise<APIResponse<EntranceSound>>;
  rename: (id: string, name: string) => Promise<APIResponse<EntranceSound>>;
  remove: (id: string) => Promise<APIResponse<void>>;
  setSelection: (body: EntranceSelectionInput) => Promise<APIResponse<EntranceSelection[]>>;
  reset: () => void;
};

let generation = 0;

function sortSounds(list: EntranceSound[]): EntranceSound[] {
  return [...list].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

export const useEntranceStore = create<EntranceState>((set, get) => ({
  sounds: [],
  selections: [],
  status: "idle",

  load: async () => {
    if (get().status === "loading") return;
    const gen = generation;
    set({ status: "loading" });
    const res = await entranceApi.listMine();
    if (gen !== generation) return;
    if (!res.success || !res.data) {
      set({ status: "error" });
      return;
    }
    set({
      sounds: sortSounds(Array.isArray(res.data.sounds) ? res.data.sounds : []),
      selections: Array.isArray(res.data.selections) ? res.data.selections : [],
      status: "ready",
    });
  },

  upload: async (blob, name) => {
    const gen = generation;
    const res = await entranceApi.uploadSound(blob, name);
    if (gen === generation && res.success && res.data) {
      const sound = res.data;
      set((s) => ({ sounds: sortSounds([...s.sounds.filter((x) => x.id !== sound.id), sound]) }));
    }
    return res;
  },

  rename: async (id, name) => {
    const gen = generation;
    const res = await entranceApi.renameSound(id, name);
    if (gen === generation && res.success && res.data) {
      const sound = res.data;
      set((s) => ({ sounds: s.sounds.map((x) => (x.id === sound.id ? sound : x)) }));
    }
    return res;
  },

  remove: async (id) => {
    const gen = generation;
    const res = await entranceApi.deleteSound(id);
    if (gen === generation && res.success) {
      // Server also drops selections bound to this clip.
      set((s) => ({
        sounds: s.sounds.filter((x) => x.id !== id),
        selections: s.selections.filter((sel) => sel.sound_id !== id),
      }));
    }
    return res;
  },

  setSelection: async (body) => {
    const gen = generation;
    const res = await entranceApi.putSelection(body);
    if (gen === generation && res.success && Array.isArray(res.data)) {
      set({ selections: res.data });
    }
    return res;
  },

  reset: () => {
    generation++;
    set({ sounds: [], selections: [], status: "idle" });
  },
}));
