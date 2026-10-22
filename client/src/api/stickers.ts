/**
 * Stickers API — per-server sticker management (Faz D2, Sözleşme §2–§5).
 *
 * Reads: any member (`GET /servers/{id}/stickers`) and the caller's own
 * aggregate across every server they belong to (`GET /users/me/stickers`).
 * Mutations require ManageExpressions on the target server.
 */

import { apiClient } from "./client";
import type { ServerSticker } from "../types/expression";

export type CreateStickerForm = {
  file: File;
  display_name: string;
  name?: string;
  description?: string;
  tags?: string[];
  copyable?: boolean;
};

export type UpdateStickerPatch = {
  name?: string;
  display_name?: string;
  description?: string;
  tags?: string[];
  copyable?: boolean;
};

export function listServerStickers(serverId: string) {
  return apiClient<ServerSticker[]>(`/servers/${serverId}/stickers`);
}

export function listMyStickers() {
  return apiClient<ServerSticker[]>("/users/me/stickers");
}

export function createSticker(serverId: string, form: CreateStickerForm) {
  const fd = new FormData();
  fd.append("file", form.file);
  fd.append("display_name", form.display_name);
  if (form.name) fd.append("name", form.name);
  if (form.description) fd.append("description", form.description);
  if (form.tags && form.tags.length > 0) fd.append("tags", form.tags.join(","));
  if (form.copyable !== undefined) fd.append("copyable", form.copyable ? "true" : "false");
  return apiClient<ServerSticker>(`/servers/${serverId}/stickers`, {
    method: "POST",
    body: fd,
  });
}

export function updateSticker(serverId: string, stickerId: string, patch: UpdateStickerPatch) {
  return apiClient<ServerSticker>(`/servers/${serverId}/stickers/${stickerId}`, {
    method: "PATCH",
    body: patch,
  });
}

export function deleteSticker(serverId: string, stickerId: string) {
  return apiClient<void>(`/servers/${serverId}/stickers/${stickerId}`, {
    method: "DELETE",
  });
}
