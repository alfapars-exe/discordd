import { apiClient } from "./client";

export type ClipConsentSnapshot = {
  recording_id?: string;
  included_user_ids: string[];
  excluded_user_ids: string[];
};

export function getClipConsent(serverId: string, channelId: string) {
  return apiClient<ClipConsentSnapshot>(`/servers/${serverId}/voice/clips/consent?channel_id=${encodeURIComponent(channelId)}`);
}

export function startClipRecording(serverId: string, channelId: string) {
  return apiClient<ClipConsentSnapshot>(`/servers/${serverId}/voice/clips/start`, {
    method: "POST",
    body: JSON.stringify({ channel_id: channelId }),
  });
}

export function stopClipRecording(serverId: string, channelId: string, recordingId: string, durationMs: number) {
  return apiClient<null>(`/servers/${serverId}/voice/clips/${encodeURIComponent(recordingId)}/stop`, {
    method: "POST",
    body: JSON.stringify({ channel_id: channelId, duration_ms: Math.max(0, Math.round(durationMs)) }),
  });
}
