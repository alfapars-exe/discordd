import { apiClient } from "./client";
import type { CS2SteamJoinRecipe } from "../../../electron/cs2-join-contract";

export type GameJoinTarget = { target_user_id: string; context: "friend" | "voice"; server_id?: string; channel_id?: string };
export type GameJoinStatus = GameJoinTarget & { joinable: boolean; offer_revision?: number; expires_at?: string; adapter?: "cs2-steam" };
export type GameJoinTicket = { ticket_id: string; ticket: string; viewer_user_id: string; target_user_id: string; offer_revision: number; expires_at: string; adapter: "cs2-steam" };
export type ConsumedGameJoin = Omit<GameJoinTicket, "ticket" | "adapter"> & { recipe: CS2SteamJoinRecipe };
type Lifetime = { isCurrent: () => boolean; signal?: AbortSignal };
export function getGameJoinTargets(ownerId: string, targets: GameJoinTarget[], lifetime: Lifetime) {
  return apiClient<{ targets: GameJoinStatus[] }>("/game-join/targets", { method: "POST", body: { expected_user_id: ownerId, targets }, timeoutMs: 8_000, ...lifetime });
}
export function mintGameJoinTicket(ownerId: string, target: GameJoinTarget, revision: number, lifetime: Lifetime) {
  return apiClient<GameJoinTicket>("/game-join/tickets", { method: "POST", body: { expected_user_id: ownerId, ...target, expected_offer_revision: revision }, timeoutMs: 8_000, ...lifetime });
}
export function consumeGameJoinTicket(ownerId: string, ticket: string, lifetime: Lifetime) {
  return apiClient<ConsumedGameJoin>("/game-join/tickets/consume", { method: "POST", body: { expected_user_id: ownerId, ticket }, timeoutMs: 4_000, ...lifetime });
}
