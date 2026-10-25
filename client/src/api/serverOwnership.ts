import { apiClient } from "./client";
import type { MemberWithRoles, Server } from "../types";

export function getOwnershipServer(serverId: string, isCurrent: () => boolean) {
  return apiClient<Server>(`/servers/${encodeURIComponent(serverId)}`, { timeoutMs: 15000, isCurrent });
}
export function getOwnershipMembers(serverId: string, isCurrent: () => boolean) {
  return apiClient<MemberWithRoles[]>(`/servers/${encodeURIComponent(serverId)}/members`, { timeoutMs: 15000, isCurrent });
}
export function transferServerOwnership(owner: string, serverId: string, target: string, password: string, code: string, confirmText: string, isCurrent: () => boolean) {
  return apiClient<Server>(`/servers/${encodeURIComponent(serverId)}/transfer-ownership`, {
    method: "POST", timeoutMs: 15000, retryUnauthorized: false, isCurrent,
    body: { expected_user_id: owner, expected_server_id: serverId, target_user_id: target, password, code, confirm: true, confirm_text: confirmText },
  });
}
