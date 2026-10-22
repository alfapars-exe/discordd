/**
 * Entrance sounds API (Faz E, Sözleşme §3).
 *
 * `/users/me/*` endpoints are scoped to the caller (another user's sound id →
 * 404). Server endpoints are gated server-side: settings + channel toggle on
 * ManageSoundboard, member mutes on MuteMembers (+ role hierarchy).
 */

import { apiClient } from "./client";
import type {
  EntranceSelection,
  EntranceSelectionInput,
  EntranceSound,
  ServerEntranceSettings,
} from "../types/entrance";

export type EntranceLibrary = {
  sounds: EntranceSound[];
  selections: EntranceSelection[];
};

export type ServerEntranceSettingsPatch = {
  enabled?: boolean;
  max_duration_ms?: number;
};

const ERROR_KEYS: Readonly<Record<string, string>> = {
  ENTRANCE_FILE_TOO_LARGE: "errors.tooLarge",
  ENTRANCE_INVALID_AUDIO: "errors.invalidAudio",
  ENTRANCE_DURATION_INVALID: "errors.duration",
  ENTRANCE_LIMIT_REACHED: "errors.limit",
  ENTRANCE_NAME_INVALID: "errors.nameInvalid",
  ENTRANCE_PRESET_INVALID: "errors.presetInvalid",
  ENTRANCE_HIERARCHY: "errors.hierarchy",
};

/** Maps a failed response to an `entrance` i18n key (server text is never shown). */
export function entranceErrorKey(res: { code?: string; status?: number }): string {
  if (res.code && ERROR_KEYS[res.code]) return ERROR_KEYS[res.code];
  if (res.status === 413) return "errors.tooLarge";
  return "errors.generic";
}

export function listMine() {
  return apiClient<EntranceLibrary>("/users/me/entrance-sounds");
}

/** Uploads an already-rendered WAV clip. The server re-parses and re-writes it. */
export function uploadSound(file: Blob, name: string) {
  const fd = new FormData();
  fd.append("file", new File([file], "clip.wav", { type: "audio/wav" }));
  fd.append("name", name);
  return apiClient<EntranceSound>("/users/me/entrance-sounds", {
    method: "POST",
    body: fd,
  });
}

export function renameSound(id: string, name: string) {
  return apiClient<EntranceSound>(`/users/me/entrance-sounds/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { name },
  });
}

export function deleteSound(id: string) {
  return apiClient<void>(`/users/me/entrance-sounds/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function putSelection(body: EntranceSelectionInput) {
  return apiClient<EntranceSelection[]>("/users/me/entrance-selection", {
    method: "PUT",
    body,
  });
}

export function getServerSettings(serverId: string) {
  return apiClient<ServerEntranceSettings>(`/servers/${serverId}/entrance-settings`);
}

export function patchServerSettings(serverId: string, patch: ServerEntranceSettingsPatch) {
  return apiClient<ServerEntranceSettings>(`/servers/${serverId}/entrance-settings`, {
    method: "PATCH",
    body: patch,
  });
}

export function setChannelEnabled(serverId: string, channelId: string, enabled: boolean) {
  return apiClient<void>(`/servers/${serverId}/channels/${channelId}/entrance`, {
    method: "PUT",
    body: { enabled },
  });
}

export function listMutes(serverId: string) {
  return apiClient<{ user_ids: string[] }>(`/servers/${serverId}/entrance-mutes`);
}

export function muteMember(serverId: string, userId: string) {
  return apiClient<void>(`/servers/${serverId}/entrance-mutes/${userId}`, {
    method: "PUT",
  });
}

export function unmuteMember(serverId: string, userId: string) {
  return apiClient<void>(`/servers/${serverId}/entrance-mutes/${userId}`, {
    method: "DELETE",
  });
}
