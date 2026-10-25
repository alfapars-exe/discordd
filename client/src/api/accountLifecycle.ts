import { apiClient } from "./client";

export function disableAccount(owner: string, password: string, code: string, isCurrent?: () => boolean) {
  return apiClient<{ disabled: boolean }>("/users/me/disable", { method: "POST", body: { expected_user_id: owner, password, code, confirm: true }, timeoutMs: 15000, retryUnauthorized: false, isCurrent });
}
