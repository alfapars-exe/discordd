import { apiClient } from "./client";

export type GameApplicationGrant = {
  application_id: string;
  application_name: string;
  application_username: string;
  messaging_enabled: boolean;
  revision: number;
  authorized_at: string;
  updated_at: string;
  revoked_at?: string;
};

export function listGameApplicationGrants(isCurrent?: () => boolean) {
  return apiClient<{ grants: GameApplicationGrant[] }>("/application-game-grants", { timeoutMs: 15000, isCurrent });
}

export function updateGameApplicationGrant(applicationID: string, expectedRevision: number, messagingEnabled: boolean, isCurrent?: () => boolean) {
  return apiClient<GameApplicationGrant>(`/application-game-grants/${encodeURIComponent(applicationID)}`, {
    method: "PUT", body: { expected_revision: expectedRevision, messaging_enabled: messagingEnabled },
    timeoutMs: 15000, retryUnauthorized: false, isCurrent,
  });
}

export function revokeGameApplicationGrant(applicationID: string, expectedRevision: number, isCurrent?: () => boolean) {
  return apiClient<GameApplicationGrant>(`/application-game-grants/${encodeURIComponent(applicationID)}`, {
    method: "DELETE", body: { expected_revision: expectedRevision }, timeoutMs: 15000, retryUnauthorized: false, isCurrent,
  });
}

export function registerGameApplication(applicationID: string, isCurrent?: () => boolean) {
  return apiClient<{ application_id: string }>(`/bots/${encodeURIComponent(applicationID)}/game-identity`, {
    method: "POST", timeoutMs: 15000, retryUnauthorized: false, isCurrent,
  });
}
