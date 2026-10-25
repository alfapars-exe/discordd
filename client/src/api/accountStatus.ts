import { apiClient } from "./client";

export type AccountRestriction = { kind: "ban" | "timeout"; server_id: string; server_name: string; reason: string; created_at: number; expires_at: number | null };
export type AccountStatus = { platform_banned: boolean; platform_reason?: string; checked_at: number; restrictions: AccountRestriction[]; next_offset: number | null };
export function getAccountStatus(owner: string, offset = 0, isCurrent?: () => boolean) {
  return apiClient<AccountStatus>(`/users/me/account-status?expected_user_id=${encodeURIComponent(owner)}&offset=${offset}`, { timeoutMs: 15000, isCurrent });
}
