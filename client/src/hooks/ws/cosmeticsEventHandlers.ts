/**
 * Cosmetics WS handler (Faz G, Karar G-13).
 * Handles: user_cosmetics_update — one coalesced event per equip / plain
 * change: `server_id` = S with S-resolved slots to that server's members,
 * `server_id: null` with GLOBAL slots to the user themself.
 *
 * The payload is re-validated here (`parseCosmeticSlots` drops anything
 * invalid). When the update is about the viewer, `mine` is refreshed with a
 * short debounce instead of on every event (a multi-server equip fans out
 * several events at once).
 */

import { useAuthStore } from "../../stores/authStore";
import { useCosmeticsStore } from "../../stores/cosmeticsStore";
import { EMPTY_SLOTS, parseCosmeticSlots } from "../../utils/cosmetics";
import type { WSMessage } from "../../types";

export const MINE_REFRESH_DEBOUNCE_MS = 500;

let mineTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleMineRefresh(): void {
  if (mineTimer !== null) clearTimeout(mineTimer);
  mineTimer = setTimeout(() => {
    mineTimer = null;
    // Only refresh a catalog the viewer has actually opened.
    if (useCosmeticsStore.getState().mine) void useCosmeticsStore.getState().loadMine();
  }, MINE_REFRESH_DEBOUNCE_MS);
}

function applyCosmeticsUpdate(d: unknown): void {
  if (typeof d !== "object" || d === null || Array.isArray(d)) return;
  const rec = d as Record<string, unknown>;
  if (typeof rec.user_id !== "string") return;
  const serverId = rec.server_id === null || rec.server_id === undefined ? null : rec.server_id;
  if (serverId !== null && typeof serverId !== "string") return;
  const plain = rec.plain === true;

  useCosmeticsStore.getState().applyUpdate({
    user_id: rec.user_id,
    server_id: serverId,
    slots: plain ? EMPTY_SLOTS : parseCosmeticSlots(rec.slots),
    plain,
  });

  if (rec.user_id === useAuthStore.getState().user?.id) scheduleMineRefresh();
}

export function handleCosmeticsEvent(msg: WSMessage): boolean {
  switch (msg.op) {
    case "user_cosmetics_update":
      applyCosmeticsUpdate(msg.d);
      return true;
    default:
      return false;
  }
}
