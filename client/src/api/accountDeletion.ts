import { apiClient } from "./client";

export type DeletionStatus = { platform_admin: boolean; owned_count: number; resources: { kind: "server" | "application"; id: string; name: string }[]; next_offset: number | null; checked_at: number };
export function getDeletionStatus(owner: string, offset = 0, isCurrent?: () => boolean) {
  return apiClient<DeletionStatus>(`/users/me/deletion-status?expected_user_id=${encodeURIComponent(owner)}&offset=${offset}`, { timeoutMs: 15000, isCurrent });
}
export function deleteAccount(owner: string, password: string, code: string, confirmText: string, isCurrent?: () => boolean) {
  return apiClient<{ deleted: boolean; shared_history: string; personal_asset_cleanup: string }>("/users/me/delete", { method: "POST", body: { expected_user_id: owner, password, code, confirm: true, confirm_text: confirmText }, timeoutMs: 15000, retryUnauthorized: false, isCurrent });
}
