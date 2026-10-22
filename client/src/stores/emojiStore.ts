/**
 * emojiStore — the viewer's custom emoji catalog (Faz D1, Karar D-17).
 *
 * One aggregate fetch (`GET /users/me/emojis`) covers every server the user
 * belongs to. Loading is lazy: the picker, the `:` autocomplete and the
 * settings panel call `ensureLoaded(serverIds)` on first use, and the fetch
 * re-runs only when the member-server id set changes (sorted signature).
 * Views filter by the live serverStore list (hooks/useEmojiCatalog.ts — kept
 * out of this module so the store has no store imports and no cycles), so a
 * server the user just left disappears from the picker without a WS hunk.
 *
 * Per-user cache → reset on logout (#226, authStore.logout).
 */

import { create } from "zustand";
import * as emojisApi from "../api/emojis";
import type { CreateEmojiForm, UpdateEmojiPatch } from "../api/emojis";
import type { APIResponse } from "../types";
import type { ServerEmoji, ServerEmojiDeleteEvent } from "../types/expression";

export type EmojiLoadStatus = "idle" | "loading" | "ready" | "error";

type EmojiState = {
  byServer: Record<string, ServerEmoji[]>;
  byId: Record<string, ServerEmoji>;
  status: EmojiLoadStatus;
  /** Sorted, comma-joined server-id signature the catalog was loaded for. */
  loadedFor: string;

  ensureLoaded: (serverIds: string[]) => Promise<void>;
  fetchServer: (serverId: string) => Promise<void>;

  createEmoji: (serverId: string, form: CreateEmojiForm) => Promise<APIResponse<ServerEmoji>>;
  updateEmoji: (
    serverId: string,
    emojiId: string,
    patch: UpdateEmojiPatch,
  ) => Promise<APIResponse<ServerEmoji>>;
  deleteEmoji: (serverId: string, emojiId: string) => Promise<APIResponse<void>>;

  handleCreate: (emoji: ServerEmoji) => void;
  handleUpdate: (emoji: ServerEmoji) => void;
  handleDelete: (evt: ServerEmojiDeleteEvent) => void;

  reset: () => void;
};

/** Bumped by reset(); in-flight responses from an older generation are dropped. */
let generation = 0;

export function serverIdSignature(serverIds: string[]): string {
  return [...serverIds].sort().join(",");
}

function sortByName(list: ServerEmoji[]): ServerEmoji[] {
  return [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function upsert(
  state: Pick<EmojiState, "byServer" | "byId">,
  emoji: ServerEmoji,
): Pick<EmojiState, "byServer" | "byId"> {
  const byId = { ...state.byId };
  const byServer = { ...state.byServer };
  const prev = byId[emoji.id];
  // A server_id change can't happen today, but never leave a stale copy.
  if (prev && prev.server_id !== emoji.server_id) {
    byServer[prev.server_id] = (byServer[prev.server_id] ?? []).filter((e) => e.id !== emoji.id);
  }
  const list = (byServer[emoji.server_id] ?? []).filter((e) => e.id !== emoji.id);
  byServer[emoji.server_id] = sortByName([...list, emoji]);
  byId[emoji.id] = emoji;
  return { byServer, byId };
}

function remove(
  state: Pick<EmojiState, "byServer" | "byId">,
  serverId: string,
  emojiId: string,
): Pick<EmojiState, "byServer" | "byId"> {
  const byId = { ...state.byId };
  delete byId[emojiId];
  const byServer = { ...state.byServer };
  if (byServer[serverId]) byServer[serverId] = byServer[serverId].filter((e) => e.id !== emojiId);
  return { byServer, byId };
}

export const useEmojiStore = create<EmojiState>((set, get) => ({
  byServer: {},
  byId: {},
  status: "idle",
  loadedFor: "",

  ensureLoaded: async (serverIds) => {
    const sig = serverIdSignature(serverIds);
    const { loadedFor, status } = get();
    if (sig === loadedFor && (status === "ready" || status === "loading")) return;

    const gen = generation;
    set({ status: "loading", loadedFor: sig });
    const res = await emojisApi.listMyEmojis();
    if (gen !== generation || get().loadedFor !== sig) return;

    if (!res.success || !Array.isArray(res.data)) {
      set({ status: "error" });
      return;
    }
    const byServer: Record<string, ServerEmoji[]> = {};
    const byId: Record<string, ServerEmoji> = {};
    for (const e of res.data) {
      (byServer[e.server_id] ??= []).push(e);
      byId[e.id] = e;
    }
    for (const sid of Object.keys(byServer)) byServer[sid] = sortByName(byServer[sid]);
    set({ byServer, byId, status: "ready" });
  },

  fetchServer: async (serverId) => {
    const gen = generation;
    const res = await emojisApi.listServerEmojis(serverId);
    if (gen !== generation || !res.success || !Array.isArray(res.data)) return;
    const list = res.data;
    set((state) => {
      const byId = { ...state.byId };
      for (const e of state.byServer[serverId] ?? []) delete byId[e.id];
      for (const e of list) byId[e.id] = e;
      return { byServer: { ...state.byServer, [serverId]: sortByName(list) }, byId };
    });
  },

  createEmoji: async (serverId, form) => {
    const res = await emojisApi.createEmoji(serverId, form);
    if (res.success && res.data) get().handleCreate(res.data);
    return res;
  },

  updateEmoji: async (serverId, emojiId, patch) => {
    const res = await emojisApi.updateEmoji(serverId, emojiId, patch);
    if (res.success && res.data) get().handleUpdate(res.data);
    return res;
  },

  deleteEmoji: async (serverId, emojiId) => {
    const res = await emojisApi.deleteEmoji(serverId, emojiId);
    if (res.success) get().handleDelete({ id: emojiId, server_id: serverId });
    return res;
  },

  handleCreate: (emoji) => set((state) => upsert(state, emoji)),
  handleUpdate: (emoji) => set((state) => upsert(state, emoji)),
  handleDelete: (evt) => set((state) => remove(state, evt.server_id, evt.id)),

  reset: () => {
    generation++;
    set({ byServer: {}, byId: {}, status: "idle", loadedFor: "" });
  },
}));
