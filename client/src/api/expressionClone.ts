/**
 * Expression clone API (Faz D2, Sözleşme §4).
 *
 * Copies a `copyable` emoji/sticker from a server the caller is a member of
 * into `targetServerId` (ManageExpressions required there). The server copies
 * the stored file bytes; the clone's licence is locked (copyable=false).
 */

import { apiClient } from "./client";
import type { ServerEmoji, ServerSticker } from "../types/expression";

type CloneBody = { source_id: string; name?: string };

function body(sourceId: string, name?: string): CloneBody {
  return name ? { source_id: sourceId, name } : { source_id: sourceId };
}

export function cloneEmoji(targetServerId: string, sourceId: string, name?: string) {
  return apiClient<ServerEmoji>(`/servers/${targetServerId}/emojis/clone`, {
    method: "POST",
    body: body(sourceId, name),
  });
}

export function cloneSticker(targetServerId: string, sourceId: string, name?: string) {
  return apiClient<ServerSticker>(`/servers/${targetServerId}/stickers/clone`, {
    method: "POST",
    body: body(sourceId, name),
  });
}
