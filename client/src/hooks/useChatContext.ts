/**
 * ChatContext — Shared interface between Channel and DM chat components.
 *
 * Abstracts store differences so shared components (Message, MessageInput, etc.)
 * work with both channel and DM modes via a single interface (DIP).
 *
 * ChatMessage uses structural subtyping — both Message and DMMessage satisfy it.
 */

import { createContext, useContext, type RefObject } from "react";
import type { PublicUser, ReactionGroup, MessageReference, MemberWithRoles } from "../types";
import type { EncryptedFileMeta } from "../crypto/fileEncryption";

// ─── ChatMessage — Common message type ───
// Display-relevant intersection of Message and DMMessage.

export type ChatAttachment = {
  file_key_index?: number | null;
  id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
};

export type ChatMessage = {
  attachment_states?: {index: number; filename: string; status: "preparing" | "ready" | "failed"; error?: string}[];
  application_id?: string | null;
  id: string;
  user_id: string;
  content: string | null;
  edited_at: string | null;
  created_at: string;
  reply_to_id: string | null;
  is_pinned: boolean;
  author: PublicUser;
  attachments: ChatAttachment[];
  reactions: ReactionGroup[];
  referenced_message: MessageReference | null;
  /** User IDs mentioned in this message */
  mentions?: string[];
  /** Role IDs mentioned in this message */
  role_mentions?: string[];
  /** E2EE: 0 = plaintext, 1 = encrypted */
  encryption_version?: number;
  /** E2EE: File keys in send order; prefer attachment.file_key_index when present */
  e2ee_file_keys?: EncryptedFileMeta[];
};

// ─── Context Value ───

export type ChatContextValue = {
  mode: "channel" | "dm";
  channelId: string;
  channelName: string;
  /** Server ID this channel belongs to (undefined for DMs) */
  serverId?: string;

  // ─── State ───
  messages: ChatMessage[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  /** Newer messages exist after the loaded window (jumped-to-message state). */
  hasMoreAfter: boolean;
  replyingTo: ChatMessage | null;
  scrollToMessageId: string | null;
  typingUsers: string[];

  // ─── Message Actions ───
  sendMessage: (content: string, files?: File[], replyToId?: string) => Promise<boolean>;
  editMessage: (id: string, content: string) => Promise<boolean>;
  deleteMessage: (id: string) => Promise<boolean>;
  fetchMessages: () => Promise<void>;
  fetchOlderMessages: () => Promise<void>;
  /** Forward paging out of a jumped-to window (no-op unless hasMoreAfter). */
  fetchNewerMessages: () => Promise<void>;
  /** Drop the jumped-to window and reload the channel tail. */
  jumpToPresent: () => void;

  // ─── Reaction ───
  toggleReaction: (messageId: string, emoji: string) => void;

  // ─── Reply ───
  setReplyingTo: (msg: ChatMessage | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  // ─── Typing ───
  sendTyping: () => void;

  // ─── Pin ───
  pinMessage: (messageId: string) => Promise<void>;
  unpinMessage: (messageId: string) => Promise<void>;
  isMessagePinned: (messageId: string) => boolean;

  // ─── File Drop ───
  /** Ref for passing dropped files from ChatArea to MessageInput */
  addFilesRef: RefObject<((files: File[]) => void) | null>;

  // ─── Permissions / UI ───
  canSend: boolean;
  canManageMessages: boolean;
  showRoleColors: boolean;
  members: MemberWithRoles[];
  /** ISO timestamp of the viewer's own active moderator timeout on this
   *  server, if any. Optional — DMs never set it (no server, no timeouts),
   *  so DMChatProvider's ChatContextValue compiles unchanged. */
  selfTimeoutExpiresAt?: string;
};

// ─── Context ───

const ChatContext = createContext<ChatContextValue | null>(null);

/**
 * useChatContext — Must be called within ChannelChatProvider or DMChatProvider.
 * Throws if used outside a provider.
 */
export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return ctx;
}

export { ChatContext };
