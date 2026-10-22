/**
 * stickerStore — the viewer's sticker catalog (Faz D2, Karar D2-19).
 *
 * Mirror of emojiStore: one aggregate fetch (`GET /users/me/stickers`)
 * covers every server the user belongs to, loaded lazily via
 * `ensureLoaded(serverIds)` and re-run only when the member-server id set
 * changes. Views filter by the live serverStore list
 * (hooks/useStickerCatalog.ts), so this store imports no other store.
 *
 * Per-user cache → reset on logout (#226, authStore.logout).
 */

import { create } from "zustand";
import * as stickersApi from "../api/stickers";
import type { CreateStickerForm, UpdateStickerPatch } from "../api/stickers";
import type { APIResponse } from "../types";
import type { ServerSticker, ServerStickerDeleteEvent } from "../types/expression";

export type StickerLoadStatus = "idle" | "loading" | "ready" | "error";

type StickerState = {
  byServer: Record<string, ServerSticker[]>;
  byId: Record<string, ServerSticker>;
  status: StickerLoadStatus;
  /** Sorted, comma-joined server-id signature the catalog was loaded for. */
  loadedFor: string;

  ensureLoaded: (serverIds: string[]) => Promise<void>;
  fetchServer: (serverId: string) => Promise<void>;

  createSticker: (serverId: string, form: CreateStickerForm) => Promise<APIResponse<ServerSticker>>;
  updateSticker: (
    serverId: string,
    stickerId: string,
    patch: UpdateStickerPatch,
  ) => Promise<APIResponse<ServerSticker>>;
  deleteSticker: (serverId: string, stickerId: string) => Promise<APIResponse<void>>;

  handleCreate: (sticker: ServerSticker) => void;
  handleUpdate: (sticker: ServerSticker) => void;
  handleDelete: (evt: ServerStickerDeleteEvent) => void;

  reset: () => void;
};

/** Bumped by reset(); in-flight responses from an older generation are dropped. */
let generation = 0;

function signature(serverIds: string[]): string {
  return [...serverIds].sort().join(",");
}

function sortByName(list: ServerSticker[]): ServerSticker[] {
  return [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function upsert(
  state: Pick<StickerState, "byServer" | "byId">,
  sticker: ServerSticker,
): Pick<StickerState, "byServer" | "byId"> {
  const byId = { ...state.byId };
  const byServer = { ...state.byServer };
  const prev = byId[sticker.id];
  if (prev && prev.server_id !== sticker.server_id) {
    byServer[prev.server_id] = (byServer[prev.server_id] ?? []).filter((s) => s.id !== sticker.id);
  }
  const list = (byServer[sticker.server_id] ?? []).filter((s) => s.id !== sticker.id);
  byServer[sticker.server_id] = sortByName([...list, sticker]);
  byId[sticker.id] = sticker;
  return { byServer, byId };
}

function remove(
  state: Pick<StickerState, "byServer" | "byId">,
  serverId: string,
  stickerId: string,
): Pick<StickerState, "byServer" | "byId"> {
  const byId = { ...state.byId };
  delete byId[stickerId];
  const byServer = { ...state.byServer };
  if (byServer[serverId]) byServer[serverId] = byServer[serverId].filter((s) => s.id !== stickerId);
  return { byServer, byId };
}

export const useStickerStore = create<StickerState>((set, get) => ({
  byServer: {},
  byId: {},
  status: "idle",
  loadedFor: "",

  ensureLoaded: async (serverIds) => {
    const sig = signature(serverIds);
    const { loadedFor, status } = get();
    if (sig === loadedFor && (status === "ready" || status === "loading")) return;

    const gen = generation;
    set({ status: "loading", loadedFor: sig });
    const res = await stickersApi.listMyStickers();
    if (gen !== generation || get().loadedFor !== sig) return;

    if (!res.success || !Array.isArray(res.data)) {
      set({ status: "error" });
      return;
    }
    const byServer: Record<string, ServerSticker[]> = {};
    const byId: Record<string, ServerSticker> = {};
    for (const s of res.data) {
      (byServer[s.server_id] ??= []).push(s);
      byId[s.id] = s;
    }
    for (const sid of Object.keys(byServer)) byServer[sid] = sortByName(byServer[sid]);
    set({ byServer, byId, status: "ready" });
  },

  fetchServer: async (serverId) => {
    const gen = generation;
    const res = await stickersApi.listServerStickers(serverId);
    if (gen !== generation || !res.success || !Array.isArray(res.data)) return;
    const list = res.data;
    set((state) => {
      const byId = { ...state.byId };
      for (const s of state.byServer[serverId] ?? []) delete byId[s.id];
      for (const s of list) byId[s.id] = s;
      return { byServer: { ...state.byServer, [serverId]: sortByName(list) }, byId };
    });
  },

  createSticker: async (serverId, form) => {
    const res = await stickersApi.createSticker(serverId, form);
    if (res.success && res.data) get().handleCreate(res.data);
    return res;
  },

  updateSticker: async (serverId, stickerId, patch) => {
    const res = await stickersApi.updateSticker(serverId, stickerId, patch);
    if (res.success && res.data) get().handleUpdate(res.data);
    return res;
  },

  deleteSticker: async (serverId, stickerId) => {
    const res = await stickersApi.deleteSticker(serverId, stickerId);
    if (res.success) get().handleDelete({ id: stickerId, server_id: serverId });
    return res;
  },

  handleCreate: (sticker) => set((state) => upsert(state, sticker)),
  handleUpdate: (sticker) => set((state) => upsert(state, sticker)),
  handleDelete: (evt) => set((state) => remove(state, evt.server_id, evt.id)),

  reset: () => {
    generation++;
    set({ byServer: {}, byId: {}, status: "idle", loadedFor: "" });
  },
}));
