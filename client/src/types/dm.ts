/**
 * Direct Message (DM) types — 1-1 conversation between two users.
 * Separate from server-channel messages because backend stores them
 * in dm_channels / dm_messages tables; shapes overlap but are not
 * structurally identical (e.g. is_pinned at row level for DMs).
 */

import type { PublicUser } from "./user";
import type { ReactionGroup } from "./common";
import type { MessageReference } from "./message";
import type { EncryptionVersion } from "./e2ee";

/**
 * Last-message preview carried on the DM channel list. `content` is null
 * whenever the message is E2EE (encryption_version=1) or file-only — the
 * server never ships ciphertext here.
 */
export type DMLastMessage = {
  id: string;
  user_id: string;
  content: string | null;
  encryption_version: 0 | 1;
  created_at: string;
};

/** DM channel with the other participant's user info. */
export type DMChannelWithUser = {
  id: string;
  other_user: PublicUser;
  e2ee_enabled: boolean;
  status: "accepted" | "pending";
  initiated_by: string | null;
  created_at: string;
  last_message_at: string | null;
  is_pinned: boolean;
  is_muted: boolean;
  /** Server-side unread count (per-user read cursor). */
  unread_count: number;
  oldest_unread_message_id?: string;
  last_message: DMLastMessage | null;
};

export type DMMessage = {
  /** Immutable server-derived game application origin; absent for legacy/human messages. */
  application_id?: string | null;
  id: string;
  dm_channel_id: string;
  user_id: string;
  content: string | null;
  edited_at: string | null;
  created_at: string;
  reply_to_id: string | null;
  is_pinned: boolean;
  author: PublicUser;
  attachments: DMAttachment[];
  reactions: ReactionGroup[];
  referenced_message: MessageReference | null;
  encryption_version: EncryptionVersion; // 0=plaintext, 1=E2EE
  ciphertext?: string | null;
  sender_device_id?: string | null;
  e2ee_metadata?: string | null;
  /** Client-only: decrypted file keys */
  e2ee_file_keys?: import("../crypto/fileEncryption").EncryptedFileMeta[];
};

export type DMAttachment = {
  id: string;
  dm_message_id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
};

export type DMMessagePage = {
  messages: DMMessage[];
  has_more: boolean;
  /** Newer messages exist after the window (?around= / ?after= pages only). */
  has_more_after?: boolean;
};
