/**
 * Direct Message (DM) types — 1-1 conversation between two users.
 * Separate from server-channel messages because backend stores them
 * in dm_channels / dm_messages tables; shapes overlap but are not
 * structurally identical (e.g. is_pinned at row level for DMs).
 */

import type { User } from "./user";
import type { ReactionGroup } from "./common";
import type { MessageReference } from "./message";
import type { EncryptionVersion } from "./e2ee";

/** DM channel with the other participant's user info. */
export type DMChannelWithUser = {
  id: string;
  other_user: User;
  e2ee_enabled: boolean;
  status: "accepted" | "pending";
  initiated_by: string | null;
  created_at: string;
  last_message_at: string | null;
  is_pinned: boolean;
  is_muted: boolean;
};

export type DMMessage = {
  id: string;
  dm_channel_id: string;
  user_id: string;
  content: string | null;
  edited_at: string | null;
  created_at: string;
  reply_to_id: string | null;
  is_pinned: boolean;
  author: User;
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
};
