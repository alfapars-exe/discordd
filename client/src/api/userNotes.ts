/**
 * User notes API — the viewer's private note about another user.
 *
 * - GET /api/users/{userId}/note        → { note, updated_at }
 * - PUT /api/users/{userId}/note {note} → same ("" deletes; updated_at null)
 */

import { apiClient } from "./client";
import type { UserNote } from "../types";

/** Server-side cap on note length (characters). */
export const USER_NOTE_MAX_LENGTH = 1024;

export function getUserNote(userId: string) {
  return apiClient<UserNote>(`/users/${userId}/note`);
}

export function putUserNote(userId: string, note: string) {
  return apiClient<UserNote>(`/users/${userId}/note`, {
    method: "PUT",
    body: { note },
  });
}
