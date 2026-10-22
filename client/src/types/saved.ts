/**
 * Saved messages ("bookmarks") + per-user private notes.
 *
 * Mirrors the Go models behind /api/users/me/saved and /api/users/{id}/note.
 * A saved row references EITHER a channel message (`message_id`) OR a DM
 * message (`dm_message_id`); the matching embedded ref is a trimmed-down
 * snapshot of the message row (no attachments/reactions — only a count)
 * and is null once the original message has been deleted.
 */

import type { PublicUser } from "./user";

/** Channel message snapshot embedded in a SavedMessage. */
export type SavedMessageRef = {
  id: string;
  channel_id: string;
  server_id: string;
  channel_name: string;
  server_name: string;
  user_id: string;
  /** Plaintext content; null for E2EE rows (decrypted client-side). */
  content: string | null;
  encryption_version: number;
  ciphertext?: string;
  sender_device_id?: string;
  e2ee_metadata?: string;
  created_at: string;
  attachment_count: number;
  author: PublicUser | null;
};

/** DM message snapshot embedded in a SavedMessage. */
export type SavedDMMessageRef = Omit<
  SavedMessageRef,
  "channel_id" | "server_id" | "channel_name" | "server_name"
> & { dm_channel_id: string };

export type SavedMessage = {
  id: string;
  user_id: string;
  note: string | null;
  created_at: string;
  message_id: string | null;
  dm_message_id: string | null;
  message: SavedMessageRef | null;
  dm_message: SavedDMMessageRef | null;
  /**
   * Stub row: the message was deleted or is no longer readable by the user
   * (left the server, lost channel access). Both refs are null; the row can
   * only be removed.
   */
  unavailable: boolean;
};

/**
 * Cursor page of saved rows, newest bookmark first. `next_before` is the
 * server's cursor for the next page (null at the end) — never derive it
 * from the last visible row.
 */
export type SavedPage = { saved: SavedMessage[]; has_more: boolean; next_before: string | null };

/** Every bookmarked message id, split by origin (for the "is saved?" lookup). */
export type SavedIds = { message_ids: string[]; dm_message_ids: string[] };

/** Private note the viewer keeps about another user. */
export type UserNote = { note: string; updated_at: string | null };
