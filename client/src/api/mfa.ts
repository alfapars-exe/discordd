import { apiClient } from "./client";

export type MFAStatus = { enabled: boolean; recovery_remaining: number };
export type MFASetup = { setup_id: string; secret: string; uri: string; expires_at: number };

export function getMFAStatus(userID: string) {
  return apiClient<MFAStatus>(`/users/me/mfa?expected_user_id=${encodeURIComponent(userID)}`, { timeoutMs: 15000 });
}
export function beginMFA(userID: string, password: string) {
  return apiClient<MFASetup>("/users/me/mfa/setup", { method: "POST", body: { expected_user_id: userID, password }, timeoutMs: 15000, retryUnauthorized: false });
}
export function confirmMFA(userID: string, setupID: string, code: string) {
  return apiClient<{ recovery_codes: string[] }>("/users/me/mfa/confirm", { method: "POST", body: { expected_user_id: userID, setup_id: setupID, code }, timeoutMs: 15000, retryUnauthorized: false });
}
export function cancelMFA(userID: string, setupID: string) {
  return apiClient<{ cancelled: boolean }>("/users/me/mfa/cancel", { method: "POST", body: { expected_user_id: userID, setup_id: setupID }, timeoutMs: 15000, retryUnauthorized: false });
}
export function regenerateMFA(userID: string, password: string, code: string) {
  return apiClient<{ recovery_codes: string[] }>("/users/me/mfa/recovery", { method: "POST", body: { expected_user_id: userID, password, code }, timeoutMs: 15000, retryUnauthorized: false });
}
export function disableMFA(userID: string, password: string, code: string) {
  return apiClient<MFAStatus>("/users/me/mfa/disable", { method: "POST", body: { expected_user_id: userID, password, code }, timeoutMs: 15000, retryUnauthorized: false });
}
