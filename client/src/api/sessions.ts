import { apiClient } from "./client";

export type AuthSession = { id: string; client_type: string; user_agent: string; created_at: number; last_active_at: number; expires_at: number; current: boolean };
export type AuthSessions = { sessions: AuthSession[]; current_session_id: string };

export function getSessions(userID: string, isCurrent?: () => boolean) {
  return apiClient<AuthSessions>(`/users/me/sessions?expected_user_id=${encodeURIComponent(userID)}`, { timeoutMs: 15000, isCurrent });
}
export function revokeSession(userID: string, sessionID: string, password: string, code: string, isCurrent?: () => boolean) {
  return apiClient<{ revoked_count: number; current_revoked: boolean }>(`/users/me/sessions/${encodeURIComponent(sessionID)}/revoke`, { method: "POST", body: { expected_user_id: userID, password, code }, timeoutMs: 15000, retryUnauthorized: false, isCurrent });
}
