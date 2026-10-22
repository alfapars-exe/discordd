/**
 * Saved messages API — the current user's bookmarks.
 *
 * - GET    /api/users/me/saved?before=&limit=  — cursor page (newest first)
 * - GET    /api/users/me/saved/ids             — every saved message id
 * - POST   /api/users/me/saved                 — save (idempotent)
 * - PATCH  /api/users/me/saved/{id}            — edit note
 * - DELETE /api/users/me/saved/{id}            — remove bookmark
 */

import { apiClient } from "./client";
import type { SavedIds, SavedMessage, SavedPage } from "../types";

/** Backend error code when the 500-bookmark cap is reached. */
export const SAVED_LIMIT_REACHED = "saved_limit_reached";

/** Exactly one of the two ids is set. */
export type SaveMessageBody = {
  message_id?: string;
  dm_message_id?: string;
  note?: string;
};

export type ListSavedParams = {
  /** Cursor: return bookmarks older than this saved id. */
  before?: string;
  limit?: number;
};

export function listSaved(params: ListSavedParams = {}) {
  const query = new URLSearchParams();
  if (params.before) query.set("before", params.before);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const qs = query.toString();
  return apiClient<SavedPage>(`/users/me/saved${qs ? `?${qs}` : ""}`);
}

export function getSavedIds() {
  return apiClient<SavedIds>("/users/me/saved/ids");
}

export function saveMessage(body: SaveMessageBody) {
  return apiClient<SavedMessage>("/users/me/saved", { method: "POST", body });
}

export function updateSavedNote(savedId: string, note: string) {
  return apiClient<SavedMessage>(`/users/me/saved/${savedId}`, {
    method: "PATCH",
    body: { note },
  });
}

export function deleteSaved(savedId: string) {
  return apiClient<void>(`/users/me/saved/${savedId}`, { method: "DELETE" });
}
