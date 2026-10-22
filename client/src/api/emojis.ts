/**
 * Emojis API — per-server custom emoji management (Faz D1, Sözleşme §2–§4).
 *
 * Reads: any member (`GET /servers/{id}/emojis`) and the caller's own
 * aggregate across every server they belong to (`GET /users/me/emojis`).
 * Mutations require ManageExpressions on the target server.
 */

import { apiClient } from "./client";
import type { ServerEmoji } from "../types/expression";

export type CreateEmojiForm = {
  file: File;
  display_name: string;
  name?: string;
  copyable?: boolean;
};

export type UpdateEmojiPatch = {
  name?: string;
  display_name?: string;
  copyable?: boolean;
};

export function listServerEmojis(serverId: string) {
  return apiClient<ServerEmoji[]>(`/servers/${serverId}/emojis`);
}

export function listMyEmojis() {
  return apiClient<ServerEmoji[]>("/users/me/emojis");
}

export function createEmoji(serverId: string, form: CreateEmojiForm) {
  const fd = new FormData();
  fd.append("file", form.file);
  fd.append("display_name", form.display_name);
  if (form.name) fd.append("name", form.name);
  if (form.copyable !== undefined) fd.append("copyable", form.copyable ? "true" : "false");
  return apiClient<ServerEmoji>(`/servers/${serverId}/emojis`, {
    method: "POST",
    body: fd,
  });
}

export function updateEmoji(serverId: string, emojiId: string, patch: UpdateEmojiPatch) {
  return apiClient<ServerEmoji>(`/servers/${serverId}/emojis/${emojiId}`, {
    method: "PATCH",
    body: patch,
  });
}

export function deleteEmoji(serverId: string, emojiId: string) {
  return apiClient<void>(`/servers/${serverId}/emojis/${emojiId}`, {
    method: "DELETE",
  });
}
