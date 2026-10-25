import { apiClient } from "./client";

export type EmailVerificationStatus = { email: string | null; generation: number; verified: boolean; verified_at: number | null; delivery_available: boolean; retry_after: number };
export function getEmailVerification(owner: string, isCurrent?: () => boolean) {
  return apiClient<EmailVerificationStatus>(`/users/me/email-verification?expected_user_id=${encodeURIComponent(owner)}`, { timeoutMs: 15000, isCurrent });
}
export function requestEmailVerification(owner: string, generation: number, isCurrent?: () => boolean) {
  return apiClient<{ accepted: boolean }>("/users/me/email-verification", { method: "POST", body: { expected_user_id: owner, generation }, timeoutMs: 15000, retryUnauthorized: false, isCurrent });
}
export function verifyEmail(token: string) {
  return apiClient<{ verified: boolean }>("/auth/verify-email", { method: "POST", body: { token }, timeoutMs: 15000, skipAuthRefresh: true, retryUnauthorized: false });
}
