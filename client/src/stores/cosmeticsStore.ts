/**
 * cosmeticsStore — cosmetics cache (Faz G).
 *
 *   mine      — the viewer's own catalog / grants / equipped slots (settings tab)
 *   byServer  — resolved slots of a server's members (GET /servers/{id}/cosmetics)
 *   global    — GLOBAL slots of arbitrary users (DM / friends context), fetched
 *               through a 50 ms debounced batch lookup (≤100 ids per call) with a
 *               5 min TTL; empty answers are cached too (negative cache).
 *
 * Every slot set is parsed (`parseCosmeticSlots`) on the way in, and an
 * unchanged user keeps its previous object reference so memoised rows don't
 * re-render. This store imports NO other store (D1 emojiStore cycle lesson);
 * the active-server sync lives in hooks/useServerCosmeticsSync.
 *
 * Per-user cache → reset on logout (#226, authStore.logout). The generation
 * counter turns responses that land after a reset() into no-ops.
 */

import { create } from "zustand";
import * as cosmeticsApi from "../api/cosmetics";
import type { APIResponse } from "../types";
import type {
  CosmeticGrant,
  CosmeticItem,
  CosmeticSlots,
  CosmeticsUpdateEvent,
  EquipRequest,
  MyCosmetics,
} from "../types/cosmetics";
import {
  COSMETIC_LOOKUP_MAX_IDS,
  EMPTY_SLOTS,
  isEmptySlots,
  parseCosmeticSlots,
  slotsEqual,
} from "../utils/cosmetics";

export type CosmeticsLoadStatus = "idle" | "loading" | "ready" | "error";

export const GLOBAL_LOOKUP_DEBOUNCE_MS = 50;
export const GLOBAL_TTL_MS = 5 * 60 * 1000;

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Module-level clock (eslint react-hooks/purity, §4 #234). */
const now = () => Date.now();

type UserSlotsMap = Record<string, CosmeticSlots>;

type CosmeticsState = {
  mine: MyCosmetics | null;
  mineStatus: CosmeticsLoadStatus;
  byServer: Record<string, UserSlotsMap>;
  loadedServers: Record<string, true>;
  global: UserSlotsMap;
  globalFetchedAt: Record<string, number>;

  loadMine: () => Promise<void>;
  equip: (body: EquipRequest) => Promise<APIResponse<MyCosmetics>>;
  setPlainServer: (serverId: string, plain: boolean) => Promise<APIResponse<void>>;
  loadServer: (serverId: string) => Promise<void>;
  requestGlobal: (ids: readonly string[]) => void;
  applyUpdate: (ev: CosmeticsUpdateEvent) => void;
  reset: () => void;
};

let generation = 0;
let mineInFlight: Promise<void> | null = null;
const serverInFlight = new Map<string, Promise<void>>();
const pendingGlobal = new Set<string>();
const globalInFlight = new Set<string>();
let globalTimer: ReturnType<typeof setTimeout> | null = null;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Parses a `{userId: slots}` map, reusing `prev` references for unchanged users. */
function mergeUserMap(prev: UserSlotsMap | undefined, raw: unknown): UserSlotsMap {
  const out: UserSlotsMap = {};
  if (!isRecord(raw)) return out;
  for (const [userId, value] of Object.entries(raw)) {
    if (!USER_ID_RE.test(userId)) continue;
    const parsed = parseCosmeticSlots(value);
    if (isEmptySlots(parsed)) continue;
    const old = prev?.[userId];
    out[userId] = old && slotsEqual(old, parsed) ? old : parsed;
  }
  return out;
}

function normalizeMine(raw: unknown): MyCosmetics {
  const rec = isRecord(raw) ? raw : {};
  const equipped = isRecord(rec.equipped) ? rec.equipped : {};
  const servers: Record<string, CosmeticSlots> = {};
  if (isRecord(equipped.servers)) {
    for (const [sid, slots] of Object.entries(equipped.servers)) {
      const parsed = parseCosmeticSlots(slots);
      if (!isEmptySlots(parsed)) servers[sid] = parsed;
    }
  }
  const items = Array.isArray(rec.items)
    ? (rec.items as unknown[]).filter(
        (it): it is CosmeticItem => isRecord(it) && typeof it.id === "string" && typeof it.type === "string",
      )
    : [];
  const grants = Array.isArray(rec.grants)
    ? (rec.grants as unknown[]).filter(
        (g): g is CosmeticGrant => isRecord(g) && typeof g.item_id === "string" && typeof g.server_id === "string",
      )
    : [];
  const plain = Array.isArray(rec.plain_server_ids)
    ? (rec.plain_server_ids as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  return {
    items,
    grants,
    equipped: { global: parseCosmeticSlots(equipped.global), servers },
    plain_server_ids: plain,
  };
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const useCosmeticsStore = create<CosmeticsState>((set, get) => {
  async function lookupBatch(ids: string[], gen: number): Promise<void> {
    const res = await cosmeticsApi.lookupGlobal(ids);
    for (const id of ids) globalInFlight.delete(id);
    if (gen !== generation || !res.success || !res.data) return;
    const users = isRecord(res.data.users) ? res.data.users : {};
    const fetchedAt = now();
    set((s) => {
      const global = { ...s.global };
      const stamps = { ...s.globalFetchedAt };
      for (const id of ids) {
        stamps[id] = fetchedAt;
        const parsed = parseCosmeticSlots(users[id]);
        if (isEmptySlots(parsed)) {
          delete global[id];
          continue;
        }
        const old = global[id];
        global[id] = old && slotsEqual(old, parsed) ? old : parsed;
      }
      return { global, globalFetchedAt: stamps };
    });
  }

  function flushGlobal(): void {
    globalTimer = null;
    const ids = [...pendingGlobal];
    pendingGlobal.clear();
    if (ids.length === 0) return;
    const gen = generation;
    for (const id of ids) globalInFlight.add(id);
    for (const batch of chunk(ids, COSMETIC_LOOKUP_MAX_IDS)) {
      void lookupBatch(batch, gen);
    }
  }

  return {
    mine: null,
    mineStatus: "idle",
    byServer: {},
    loadedServers: {},
    global: {},
    globalFetchedAt: {},

    loadMine: () => {
      if (mineInFlight) return mineInFlight;
      const gen = generation;
      if (!get().mine) set({ mineStatus: "loading" });
      const p = (async () => {
        const res = await cosmeticsApi.getMine();
        if (gen !== generation) return;
        if (!res.success || !res.data) {
          set({ mineStatus: get().mine ? "ready" : "error" });
          return;
        }
        set({ mine: normalizeMine(res.data), mineStatus: "ready" });
      })().finally(() => {
        if (mineInFlight === p) mineInFlight = null;
      });
      mineInFlight = p;
      return p;
    },

    equip: async (body) => {
      const gen = generation;
      const res = await cosmeticsApi.equip(body);
      if (gen === generation && res.success && res.data) {
        set({ mine: normalizeMine(res.data), mineStatus: "ready" });
      }
      return res;
    },

    setPlainServer: async (serverId, plain) => {
      const gen = generation;
      const res = await cosmeticsApi.setPlainServer(serverId, plain);
      if (gen === generation && res.success) {
        set((s) => {
          if (!s.mine) return {};
          const others = s.mine.plain_server_ids.filter((id) => id !== serverId);
          return { mine: { ...s.mine, plain_server_ids: plain ? [...others, serverId] : others } };
        });
      }
      return res;
    },

    loadServer: (serverId) => {
      if (!serverId || get().loadedServers[serverId]) return Promise.resolve();
      const existing = serverInFlight.get(serverId);
      if (existing) return existing;
      const gen = generation;
      const p = (async () => {
        const res = await cosmeticsApi.getServerCosmetics(serverId);
        if (gen !== generation || !res.success || !res.data) return;
        const raw = res.data.users;
        set((s) => ({
          byServer: { ...s.byServer, [serverId]: mergeUserMap(s.byServer[serverId], raw) },
          loadedServers: { ...s.loadedServers, [serverId]: true },
        }));
      })().finally(() => {
        if (serverInFlight.get(serverId) === p) serverInFlight.delete(serverId);
      });
      serverInFlight.set(serverId, p);
      return p;
    },

    requestGlobal: (ids) => {
      const t = now();
      const stamps = get().globalFetchedAt;
      for (const id of ids) {
        if (!USER_ID_RE.test(id)) continue;
        const at = stamps[id];
        if (at !== undefined && t - at < GLOBAL_TTL_MS) continue;
        if (globalInFlight.has(id)) continue;
        pendingGlobal.add(id);
      }
      if (pendingGlobal.size > 0 && globalTimer === null) {
        globalTimer = setTimeout(flushGlobal, GLOBAL_LOOKUP_DEBOUNCE_MS);
      }
    },

    applyUpdate: (ev) => {
      const { user_id: userId, server_id: serverId } = ev;
      if (!USER_ID_RE.test(userId)) return;
      // Re-parsing is idempotent for already-parsed slots (defence in depth).
      const slots = ev.plain ? EMPTY_SLOTS : parseCosmeticSlots(ev.slots);

      if (serverId === null) {
        set((s) => {
          const global = { ...s.global };
          if (isEmptySlots(slots)) delete global[userId];
          else {
            const old = global[userId];
            global[userId] = old && slotsEqual(old, slots) ? old : slots;
          }
          return { global, globalFetchedAt: { ...s.globalFetchedAt, [userId]: now() } };
        });
        return;
      }

      // An unloaded server is fetched in full when it becomes active.
      if (!get().loadedServers[serverId]) return;
      set((s) => {
        const current = s.byServer[serverId] ?? {};
        const old = current[userId];
        if (isEmptySlots(slots)) {
          if (!old) return {};
          const next = { ...current };
          delete next[userId];
          return { byServer: { ...s.byServer, [serverId]: next } };
        }
        if (old && slotsEqual(old, slots)) return {};
        return { byServer: { ...s.byServer, [serverId]: { ...current, [userId]: slots } } };
      });
    },

    reset: () => {
      generation++;
      mineInFlight = null;
      serverInFlight.clear();
      pendingGlobal.clear();
      globalInFlight.clear();
      if (globalTimer !== null) {
        clearTimeout(globalTimer);
        globalTimer = null;
      }
      set({
        mine: null,
        mineStatus: "idle",
        byServer: {},
        loadedServers: {},
        global: {},
        globalFetchedAt: {},
      });
    },
  };
});
