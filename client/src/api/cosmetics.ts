/**
 * Cosmetics API (Faz G, Sözleşme §5/§6/§8).
 *
 * `/users/me/*` endpoints act on the caller only. `lookupGlobal` returns
 * GLOBAL slots only (DM / friends context); `getServerCosmetics` returns the
 * resolved slots of a server's members (membership-gated server-side).
 * Responses carry `asset: unknown` — callers parse before rendering.
 */

import { apiClient } from "./client";
import type { CosmeticSlots, EquipRequest, MyCosmetics } from "../types/cosmetics";

export type GlobalCosmeticsLookup = { users: Record<string, CosmeticSlots> };
export type ServerCosmetics = { server_id: string; users: Record<string, CosmeticSlots> };

const ERROR_KEYS: Readonly<Record<string, string>> = {
  COSMETIC_NOT_OWNED: "errors.notOwned",
  COSMETIC_SCOPE_MISMATCH: "errors.scopeMismatch",
  COSMETIC_SLOT_MISMATCH: "errors.slotMismatch",
};

/** Maps a failed response to a `cosmetics` i18n key (server text is never shown). */
export function cosmeticsErrorKey(res: { code?: string; status?: number }): string {
  if (res.status === 429) return "errors.rateLimited";
  if (res.code && ERROR_KEYS[res.code]) return ERROR_KEYS[res.code];
  return "errors.generic";
}

export function getMine() {
  return apiClient<MyCosmetics>("/users/me/cosmetics");
}

/** Atomically changes 1–5 slots of one scope ("global" or a server id). */
export function equip(body: EquipRequest) {
  return apiClient<MyCosmetics>("/users/me/cosmetics/equipped", {
    method: "PUT",
    body,
  });
}

export function setPlainServer(serverId: string, plain: boolean) {
  return apiClient<void>(`/users/me/cosmetics/plain-servers/${encodeURIComponent(serverId)}`, {
    method: "PUT",
    body: { plain },
  });
}

/** 1–100 user ids (the store batches). */
export function lookupGlobal(ids: string[]) {
  const qs = ids.map((id) => encodeURIComponent(id)).join(",");
  return apiClient<GlobalCosmeticsLookup>(`/users/cosmetics?ids=${qs}`);
}

export function getServerCosmetics(serverId: string) {
  return apiClient<ServerCosmetics>(`/servers/${encodeURIComponent(serverId)}/cosmetics`);
}
