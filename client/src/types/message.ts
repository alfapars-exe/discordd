/**
 * Message types — server-channel message shapes, attachments, pins,
 * link previews. DM message types live in dm.ts (same shape spirit
 * but separate tables on the backend).
 */

import type { User } from "./user";
import type { ReactionGroup } from "./common";
import type { EncryptionVersion } from "./e2ee";

/**
 * Reply preview info. If the referenced message was deleted,
 * author and content are null ("Original message was deleted").
 */
export type MessageReference = {
  id: string;
  author: User | null;
  content: string | null;
};

export type Message = {
  id: string;
  channel_id: string;
  user_id: string;
  /** Transient — set by backend on WS broadcast for cross-server notification routing */
  server_id?: string;
  content: string | null;
  edited_at: string | null;
  created_at: string;
  reply_to_id: string | null;
  referenced_message: MessageReference | null;
  author: User;
  attachments: Attachment[];
  mentions: string[];
  role_mentions: string[];
  reactions: ReactionGroup[];
  encryption_version: EncryptionVersion; // 0=plaintext, 1=E2EE
  ciphertext?: string | null;
  sender_device_id?: string | null;
  e2ee_metadata?: string | null;
  /** Client-only: decrypted file keys */
  e2ee_file_keys?: import("../crypto/fileEncryption").EncryptedFileMeta[];
};

export type Attachment = {
  id: string;
  message_id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
};

/** Cursor-based pagination response. */
export type MessagePage = {
  messages: Message[];
  has_more: boolean;
};

/** Pinned message with full message data and pinner info. */
export type PinnedMessage = {
  id: string;
  message_id: string;
  channel_id: string;
  pinned_by: string;
  created_at: string;
  message: Message;
  pinned_by_user: User | null;
};

/** URL Open Graph metadata (server-side fetch with SSRF protection). */
export type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  image_url: string | null;
  site_name: string | null;
  favicon_url: string | null;
};
