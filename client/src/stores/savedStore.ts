/**
 * Saved Store — the current user's bookmarked messages.
 *
 * Two independent slices:
 *   - the id index (`savedMessageIds` / `savedDMMessageIds`), loaded once via
 *     GET /saved/ids so every message row can answer "is this saved?" without
 *     paging the whole list;
 *   - the paged list (`items`), newest bookmark first, loaded when the Saved
 *     tab opens. E2EE rows are decrypted here through the same crypto entry
 *     points messageStore / dmStore use, so components never import crypto.
 *
 * The ids endpoint doesn't carry saved-row ids, so a bookmark made in an
 * earlier session has a known message id but an unknown row id until it is
 * paged in. `unsave` covers that gap by re-POSTing (idempotent — returns the
 * existing row) to learn the id, then deleting it.
 */

import { create } from "zustand";
import i18n from "../i18n";
import * as savedApi from "../api/saved";
import { useToastStore } from "./toastStore";
import { useE2EEStore } from "./e2eeStore";
import { decryptChannelMessages } from "../crypto/channelEncryption";
import { decryptDMMessages } from "../crypto/dmEncryption";
import type {
  APIResponse,
  DMMessage,
  Message,
  PublicUser,
  SavedDMMessageRef,
  SavedMessage,
  SavedMessageRef,
} from "../types";

const EMPTY_ITEMS: SavedMessage[] = [];
const PAGE_SIZE = 25;

/** Which message a bookmark points at. */
export type SavedTarget =
  | { kind: "message"; id: string }
  | { kind: "dm"; id: string };

type SavedState = {
  items: SavedMessage[];
  hasMore: boolean;
  /** Server cursor for the next page (SavedPage.next_before). */
  nextBefore: string | null;
  isLoading: boolean;
  /** Last list fetch failed (the view shows a retry hint). */
  loadError: boolean;
  idsLoaded: boolean;
  savedMessageIds: Record<string, true>;
  savedDMMessageIds: Record<string, true>;
  /** targetKey -> saved row id, for rows we have seen (list or POST response). */
  savedIdByTarget: Record<string, string>;

  // ─── Queries ───
  isSaved: (target: SavedTarget) => boolean;

  // ─── Actions ───
  /** Load the id index once; concurrent calls share one request. */
  ensureIds: () => Promise<void>;
  fetchInitial: () => Promise<void>;
  fetchMore: () => Promise<void>;
  save: (target: SavedTarget) => Promise<boolean>;
  unsave: (target: SavedTarget) => Promise<boolean>;
  toggle: (target: SavedTarget) => Promise<boolean>;
  /** Remove by saved row id (the list view knows it). */
  remove: (savedId: string) => Promise<boolean>;
  setNote: (savedId: string, note: string) => Promise<boolean>;
  /** Drop everything (logout) — the next account must not see these rows. */
  reset: () => void;
};

function targetKey(target: SavedTarget): string {
  return `${target.kind}:${target.id}`;
}

function targetOf(row: SavedMessage): SavedTarget | null {
  if (row.message_id) return { kind: "message", id: row.message_id };
  if (row.dm_message_id) return { kind: "dm", id: row.dm_message_id };
  return null;
}

function isLimitReached(res: APIResponse<unknown>): boolean {
  const code = savedApi.SAVED_LIMIT_REACHED;
  return res.code === code || (res.error ?? "").includes(code);
}

const UNKNOWN_AUTHOR: PublicUser = {
  id: "",
  username: "",
  display_name: null,
  avatar_url: null,
  status: "offline",
  custom_status: null,
  created_at: "",
};

/** Minimal Message shape for the channel decrypt path (content/keys only). */
function toChannelMessage(ref: SavedMessageRef): Message {
  return {
    id: ref.id,
    channel_id: ref.channel_id,
    user_id: ref.user_id,
    content: ref.content,
    edited_at: null,
    created_at: ref.created_at,
    reply_to_id: null,
    referenced_message: null,
    author: ref.author ?? UNKNOWN_AUTHOR,
    attachments: [],
    mentions: [],
    role_mentions: [],
    reactions: [],
    encryption_version: 1,
    ciphertext: ref.ciphertext ?? null,
    sender_device_id: ref.sender_device_id ?? null,
    e2ee_metadata: ref.e2ee_metadata ?? null,
  };
}

/** Minimal DMMessage shape for the DM decrypt path. */
function toDMMessage(ref: SavedDMMessageRef): DMMessage {
  return {
    id: ref.id,
    dm_channel_id: ref.dm_channel_id,
    user_id: ref.user_id,
    content: ref.content,
    edited_at: null,
    created_at: ref.created_at,
    reply_to_id: null,
    is_pinned: false,
    author: ref.author ?? UNKNOWN_AUTHOR,
    attachments: [],
    reactions: [],
    referenced_message: null,
    encryption_version: 1,
    ciphertext: ref.ciphertext ?? null,
    sender_device_id: ref.sender_device_id ?? null,
    e2ee_metadata: ref.e2ee_metadata ?? null,
  };
}

/**
 * Overlay client-side decrypted content onto E2EE rows. Plaintext rows pass
 * through. Skipped entirely while the E2EE store isn't ready — the DM path
 * would record spurious decryption errors for every row.
 */
async function decryptSavedRows(rows: SavedMessage[]): Promise<SavedMessage[]> {
  if (useE2EEStore.getState().initStatus !== "ready") return rows;

  const channelRows = rows.filter(
    (r) => r.message && r.message.encryption_version === 1 && r.message.ciphertext
  );
  const dmRows = rows.filter(
    (r) => r.dm_message && r.dm_message.encryption_version === 1 && r.dm_message.ciphertext
  );
  if (channelRows.length === 0 && dmRows.length === 0) return rows;

  const contentById = new Map<string, string | null>();
  if (channelRows.length > 0) {
    // Saved is account-wide and can mix servers, unlike a channel history page.
    // Each key fetch must use the bookmarked message's origin, never selection.
    const byServer = new Map<string, Message[]>();
    for (const row of channelRows) {
      const ref = row.message!;
      const batch = byServer.get(ref.server_id) ?? [];
      batch.push(toChannelMessage(ref));
      byServer.set(ref.server_id, batch);
    }
    for (const [serverId, batch] of byServer) {
      const decrypted = await decryptChannelMessages(batch, serverId);
      for (const m of decrypted) contentById.set(`message:${m.id}`, m.content);
    }
  }
  if (dmRows.length > 0) {
    const decrypted = await decryptDMMessages(dmRows.map((r) => toDMMessage(r.dm_message!)));
    for (const m of decrypted) contentById.set(`dm:${m.id}`, m.content);
  }

  return rows.map((r) => {
    if (r.message && contentById.has(`message:${r.message.id}`)) {
      return { ...r, message: { ...r.message, content: contentById.get(`message:${r.message.id}`) ?? null } };
    }
    if (r.dm_message && contentById.has(`dm:${r.dm_message.id}`)) {
      return { ...r, dm_message: { ...r.dm_message, content: contentById.get(`dm:${r.dm_message.id}`) ?? null } };
    }
    return r;
  });
}

function toast(type: "success" | "error" | "info", key: string): void {
  useToastStore.getState().addToast(type, i18n.t(key));
}

/** Shared in-flight ids request so concurrent ensureIds() calls coalesce. */
let idsInflight: Promise<void> | null = null;
/**
 * Bumped by reset(). A request started before logout compares its captured
 * value on resolve and drops its result instead of repopulating the store.
 */
let generation = 0;

const INITIAL_STATE = {
  items: EMPTY_ITEMS,
  hasMore: false,
  nextBefore: null,
  isLoading: false,
  loadError: false,
  idsLoaded: false,
  savedMessageIds: {},
  savedDMMessageIds: {},
  savedIdByTarget: {},
} satisfies Partial<SavedState>;

export const useSavedStore = create<SavedState>((set, get) => ({
  ...INITIAL_STATE,

  isSaved: (target) =>
    target.kind === "message"
      ? !!get().savedMessageIds[target.id]
      : !!get().savedDMMessageIds[target.id],

  ensureIds: () => {
    if (get().idsLoaded) return Promise.resolve();
    if (idsInflight) return idsInflight;
    const gen = generation;
    idsInflight = (async () => {
      try {
        const res = await savedApi.getSavedIds();
        if (gen !== generation) return;
        if (res.success && res.data) {
          const savedMessageIds: Record<string, true> = {};
          for (const id of res.data.message_ids ?? []) savedMessageIds[id] = true;
          const savedDMMessageIds: Record<string, true> = {};
          for (const id of res.data.dm_message_ids ?? []) savedDMMessageIds[id] = true;
          set({ savedMessageIds, savedDMMessageIds, idsLoaded: true });
        }
      } finally {
        idsInflight = null;
      }
    })();
    return idsInflight;
  },

  fetchInitial: async () => {
    const gen = generation;
    set({ isLoading: true, loadError: false });
    try {
      const res = await savedApi.listSaved({ limit: PAGE_SIZE });
      if (gen !== generation) return;
      if (!res.success || !res.data) {
        set({ loadError: true });
        return;
      }
      const page = res.data;
      const items = await decryptSavedRows(page.saved ?? []);
      if (gen !== generation) return;
      set((s) => ({
        items,
        // A page can be empty yet have more (every row on it was filtered
        // server-side): has_more + next_before stay authoritative.
        hasMore: page.has_more && !!page.next_before,
        nextBefore: page.next_before,
        savedIdByTarget: indexRows(s.savedIdByTarget, items),
      }));
    } finally {
      if (gen === generation) set({ isLoading: false });
    }
  },

  fetchMore: async () => {
    const { hasMore, isLoading, nextBefore } = get();
    if (!hasMore || isLoading || !nextBefore) return;
    const gen = generation;
    set({ isLoading: true, loadError: false });
    try {
      const res = await savedApi.listSaved({ before: nextBefore, limit: PAGE_SIZE });
      if (gen !== generation) return;
      if (!res.success || !res.data) {
        set({ loadError: true });
        return;
      }
      const page = res.data;
      const decrypted = await decryptSavedRows(page.saved ?? []);
      if (gen !== generation) return;
      const seen = new Set(get().items.map((r) => r.id));
      const fresh = decrypted.filter((r) => !seen.has(r.id));
      set((s) => ({
        items: [...s.items, ...fresh],
        hasMore: page.has_more && !!page.next_before,
        nextBefore: page.next_before,
        savedIdByTarget: indexRows(s.savedIdByTarget, fresh),
      }));
    } finally {
      if (gen === generation) set({ isLoading: false });
    }
  },

  save: async (target) => {
    const res = await savedApi.saveMessage(
      target.kind === "message" ? { message_id: target.id } : { dm_message_id: target.id }
    );
    if (!res.success || !res.data) {
      toast("error", isLimitReached(res) ? "saved:limitReached" : "saved:loadError");
      return false;
    }
    const row = res.data;
    set((s) => ({
      savedMessageIds:
        target.kind === "message" ? { ...s.savedMessageIds, [target.id]: true } : s.savedMessageIds,
      savedDMMessageIds:
        target.kind === "dm" ? { ...s.savedDMMessageIds, [target.id]: true } : s.savedDMMessageIds,
      savedIdByTarget: { ...s.savedIdByTarget, [targetKey(target)]: row.id },
      // Newest-first list: a fresh bookmark goes on top; an idempotent
      // re-save of a row we already list is left where it is.
      items: s.items.some((r) => r.id === row.id) ? s.items : [row, ...s.items],
    }));
    toast("success", "saved:saved");
    return true;
  },

  unsave: async (target) => {
    let savedId = get().savedIdByTarget[targetKey(target)];
    if (!savedId) {
      // Bookmark from an earlier session: the ids index knows the message,
      // not the row. POST is idempotent and returns the existing row.
      const res = await savedApi.saveMessage(
        target.kind === "message" ? { message_id: target.id } : { dm_message_id: target.id }
      );
      if (!res.success || !res.data) {
        toast("error", "saved:loadError");
        return false;
      }
      savedId = res.data.id;
      // Record the mapping so remove() can clear the id index for this target.
      const learned = savedId;
      set((s) => ({ savedIdByTarget: { ...s.savedIdByTarget, [targetKey(target)]: learned } }));
    }
    return get().remove(savedId);
  },

  toggle: (target) => (get().isSaved(target) ? get().unsave(target) : get().save(target)),

  remove: async (savedId) => {
    const row = get().items.find((r) => r.id === savedId);
    const target = row ? targetOf(row) : findTargetBySavedId(get().savedIdByTarget, savedId);
    const res = await savedApi.deleteSaved(savedId);
    if (!res.success) {
      toast("error", "saved:loadError");
      return false;
    }
    set((s) => {
      const savedMessageIds = { ...s.savedMessageIds };
      const savedDMMessageIds = { ...s.savedDMMessageIds };
      const savedIdByTarget = { ...s.savedIdByTarget };
      if (target) {
        if (target.kind === "message") delete savedMessageIds[target.id];
        else delete savedDMMessageIds[target.id];
        delete savedIdByTarget[targetKey(target)];
      }
      return {
        items: s.items.filter((r) => r.id !== savedId),
        savedMessageIds,
        savedDMMessageIds,
        savedIdByTarget,
      };
    });
    toast("success", "saved:unsaved");
    return true;
  },

  setNote: async (savedId, note) => {
    const res = await savedApi.updateSavedNote(savedId, note);
    if (!res.success || !res.data) {
      toast("error", "saved:loadError");
      return false;
    }
    const updated = res.data;
    set((s) => ({
      items: s.items.map((r) => (r.id === savedId ? { ...r, note: updated.note } : r)),
    }));
    return true;
  },

  reset: () => {
    generation += 1;
    idsInflight = null;
    set({ ...INITIAL_STATE });
  },
}));

function indexRows(
  current: Record<string, string>,
  rows: SavedMessage[]
): Record<string, string> {
  const next = { ...current };
  for (const row of rows) {
    const target = targetOf(row);
    if (target) next[targetKey(target)] = row.id;
  }
  return next;
}

function findTargetBySavedId(
  index: Record<string, string>,
  savedId: string
): SavedTarget | null {
  for (const [key, id] of Object.entries(index)) {
    if (id !== savedId) continue;
    const sep = key.indexOf(":");
    const kind = key.slice(0, sep);
    if (kind !== "message" && kind !== "dm") return null;
    return { kind, id: key.slice(sep + 1) };
  }
  return null;
}
