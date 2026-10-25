import { apiClient } from "./client";

export const SERVER_APPLICATIONS_CHANGED_EVENT = "hichat:server-applications-changed";

export type ApplicationIdentity = {
  id: string;
  username: string;
  display_name: string | null;
  created_at: string;
  is_bot: true;
};

export type ApplicationTransferRequest = {
  id: string; application_id: string; application_username: string; application_name: string;
  from_user_id: string; from_name: string; to_user_id: string; created_at: string; expires_at: string;
};

export type ApplicationAction = { id?: string; application_id?: string; name: string; label: string; context: "message"; position?: number };
export type ApplicationManifest = { application_id: string; description: string; test_mode: boolean; updated_at: string; actions: ApplicationAction[] };
export type ApplicationInstallation = { application_id: string; application_name: string; server_id: string; scopes: string[]; installed_by: string; installed_at: string; revoked_at?: string };
export type ApplicationInvocation = { id: string; action_id: string; application_id: string; actor_user_id: string; status: "pending" | "succeeded" | "failed" | "expired"; result_text?: string; error_code?: string; expires_at: string; completed_at?: string };

export function listApplications(isCurrent?: () => boolean) {
  return apiClient<{ bots: ApplicationIdentity[] }>("/bots", { timeoutMs: 15000, isCurrent });
}

export function createApplication(username: string, displayName: string, isCurrent?: () => boolean) {
  return apiClient<{ bot: ApplicationIdentity; token: string }>("/bots", {
    method: "POST", body: { username, display_name: displayName }, timeoutMs: 15000,
    retryUnauthorized: false, isCurrent,
  });
}

export function revokeApplicationCredentials(applicationID: string, isCurrent?: () => boolean) {
  return apiClient<void>(`/bots/${encodeURIComponent(applicationID)}/revoke`, {
    method: "POST", timeoutMs: 15000, retryUnauthorized: false, isCurrent,
  });
}

export function requestApplicationTransfer(applicationID: string, recipientUsername: string, isCurrent?: () => boolean) {
  return apiClient<ApplicationTransferRequest>(`/bots/${encodeURIComponent(applicationID)}/transfer-requests`, {
    method: "POST", body: { recipient_username: recipientUsername }, timeoutMs: 15000, retryUnauthorized: false, isCurrent,
  });
}

export function listIncomingApplicationTransfers(isCurrent?: () => boolean) {
  return apiClient<{ requests: ApplicationTransferRequest[] }>("/application-transfer-requests", { timeoutMs: 15000, isCurrent });
}

export function resolveApplicationTransfer(requestID: string, accept: boolean, isCurrent?: () => boolean) {
  return apiClient<{ accepted: boolean; token?: string }>(`/application-transfer-requests/${encodeURIComponent(requestID)}/resolve`, {
    method: "POST", body: { accept }, timeoutMs: 15000, retryUnauthorized: false, isCurrent,
  });
}

export function removeApplication(
  ownerID: string, applicationID: string, password: string, code: string,
  confirmText: string, isCurrent?: () => boolean,
) {
  return apiClient<{ removed: boolean; shared_history: string; personal_asset_cleanup: string }>(
    `/bots/${encodeURIComponent(applicationID)}/remove`, {
      method: "POST",
      body: {
        expected_user_id: ownerID, expected_application_id: applicationID,
        password, code, confirm: true, confirm_text: confirmText,
      },
      timeoutMs: 15000, retryUnauthorized: false, isCurrent,
    },
  );
}

export function listApplicationManifests(isCurrent?: () => boolean) {
  return apiClient<{ applications: ApplicationManifest[] }>("/application-manifests", { timeoutMs: 15000, isCurrent });
}

export function saveApplicationManifest(applicationID: string, description: string, testMode: boolean, actions: ApplicationAction[], isCurrent?: () => boolean) {
  return apiClient<ApplicationManifest>(`/bots/${encodeURIComponent(applicationID)}/manifest`, {
    method: "PUT", body: { description, test_mode: testMode, actions }, timeoutMs: 15000, retryUnauthorized: false, isCurrent,
  });
}

export function invokeApplicationTest(applicationID: string, actionID: string, isCurrent?: () => boolean) {
  return apiClient<ApplicationInvocation>(`/bots/${encodeURIComponent(applicationID)}/actions/${encodeURIComponent(actionID)}/test`, {
    method: "POST", timeoutMs: 15000, retryUnauthorized: false, isCurrent,
  });
}

export function getApplicationInvocation(invocationID: string, isCurrent?: () => boolean) {
  return apiClient<ApplicationInvocation>(`/application-invocations/${encodeURIComponent(invocationID)}`, { timeoutMs: 15000, isCurrent });
}

export function listServerApplications(serverID: string, isCurrent?: () => boolean) {
  return apiClient<{ applications: ApplicationInstallation[] }>(`/servers/${encodeURIComponent(serverID)}/applications`, { timeoutMs: 15000, isCurrent });
}

export function listServerApplicationActions(serverID: string, isCurrent?: () => boolean) {
  return apiClient<{ actions: ApplicationAction[] }>(`/servers/${encodeURIComponent(serverID)}/application-actions`, { timeoutMs: 15000, isCurrent });
}

export function installServerApplication(serverID: string, applicationID: string, scopes: string[], isCurrent?: () => boolean) {
  return apiClient<ApplicationInstallation>(`/servers/${encodeURIComponent(serverID)}/applications/${encodeURIComponent(applicationID)}`, {
    method: "PUT", body: { scopes }, timeoutMs: 15000, retryUnauthorized: false, isCurrent,
  });
}

export function revokeServerApplication(serverID: string, applicationID: string, isCurrent?: () => boolean) {
  return apiClient<void>(`/servers/${encodeURIComponent(serverID)}/applications/${encodeURIComponent(applicationID)}`, {
    method: "DELETE", timeoutMs: 15000, retryUnauthorized: false, isCurrent,
  });
}

export function invokeMessageApplicationAction(serverID: string, channelID: string, messageID: string, actionID: string, isCurrent?: () => boolean) {
  return apiClient<ApplicationInvocation>(`/servers/${encodeURIComponent(serverID)}/channels/${encodeURIComponent(channelID)}/messages/${encodeURIComponent(messageID)}/application-actions/${encodeURIComponent(actionID)}`, {
    method: "POST", timeoutMs: 15000, retryUnauthorized: false, isCurrent,
  });
}
