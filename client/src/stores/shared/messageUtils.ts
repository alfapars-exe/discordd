/**
 * Shared Message Utilities — extracted from messageStore and dmStore
 * to eliminate duplication in message CRUD, typing, and WS handlers.
 */

import { encryptFile } from "../../crypto/fileEncryption";
import type { EncryptedFileMeta } from "../../crypto/fileEncryption";
import type { ReactionGroup } from "../../types";

// ─── File Encryption ───

export type EncryptedFileResult = {
  files: File[];
  metas: EncryptedFileMeta[];
};

/**
 * Encrypts files with AES-256-GCM for E2EE messages.
 * Shared between channel and DM sendMessage flows.
 */
export async function encryptFilesForE2EE(
  files: File[]
): Promise<EncryptedFileResult> {
  const encrypted: File[] = [];
  const metas: EncryptedFileMeta[] = [];

  for (let i = 0; i < files.length; i++) {
    const result = await encryptFile(files[i]);
    encrypted.push(
      new File([result.encryptedBlob], `encrypted_${i}.bin`, {
        type: "application/octet-stream",
      })
    );
    metas.push(result.meta);
  }

  return { files: encrypted, metas };
}

// ─── Typing Indicator ───

const TYPING_TIMEOUT = 5_000;

/**
 * Creates a typing handler with its own timer map.
 * Both messageStore and dmStore use identical typing logic.
 *
 * @param set - Zustand set function with typingUsers field
 */
export function createTypingHandler(
  set: (
    fn: (state: { typingUsers: Record<string, string[]> }) => {
      typingUsers: Record<string, string[]>;
    }
  ) => void
) {
  type PendingTyping = { channelId: string; timer?: ReturnType<typeof setTimeout> };
  const timers = new Map<string, PendingTyping>();

  const clear = (channelId?: string) => {
    for (const [key, entry] of timers) {
      if (channelId !== undefined && entry.channelId !== channelId) continue;
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      timers.delete(key);
    }
  };

  const handle = (channelId: string, username: string) => {
    const key = JSON.stringify([channelId, username]);
    const previous = timers.get(key);
    if (previous?.timer !== undefined) clearTimeout(previous.timer);
    const entry: PendingTyping = { channelId };
    // Reserve before notifying observers: a reset may retire this work while
    // set is still publishing. Only its surviving owner may install the timer.
    timers.set(key, entry);
    try {
      set((state) => {
        const current = state.typingUsers[channelId] ?? [];
        if (current.includes(username)) return state;
        return { typingUsers: { ...state.typingUsers, [channelId]: [...current, username] } };
      });
    } finally {
      if (timers.get(key) === entry) {
        entry.timer = setTimeout(() => {
          if (timers.get(key) !== entry) return;
          timers.delete(key);
          set((state) => ({
            typingUsers: {
              ...state.typingUsers,
              [channelId]: (state.typingUsers[channelId] ?? []).filter(user => user !== username),
            },
          }));
        }, TYPING_TIMEOUT);
      }
    }
  };
  return Object.assign(handle, { clear });
}

/** Keep loaded copies and admit only the first occurrence of each new id. */
export function unseenMessages<T extends { id: string }>(loaded: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set(loaded.map(message => message.id));
  return incoming.filter(message => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

// ─── Generic WS Message Handlers ───

/**
 * Generic message-update handler. Replaces a message by ID in a keyed record.
 * Used by both handleMessageUpdate and handleDMMessageUpdate.
 */
export function updateMessageInRecord<
  T extends { id: string }
>(
  messagesByChannel: Record<string, T[]>,
  channelId: string,
  updatedMessage: T,
  merge?: (current: T, update: T) => T
): Record<string, T[]> {
  const messages = messagesByChannel[channelId];
  const index = messages?.findIndex((message) => message.id === updatedMessage.id) ?? -1;
  if (index < 0) return messagesByChannel;
  const next = messages.slice();
  next[index] = merge ? merge(messages[index], updatedMessage) : updatedMessage;
  return { ...messagesByChannel, [channelId]: next };
}

/**
 * Generic message-delete handler. Removes message and nullifies reply references.
 * Used by both handleMessageDelete and handleDMMessageDelete.
 */
export function deleteMessageFromRecord<
  T extends { id: string; reply_to_id?: string | null; referenced_message?: unknown }
>(
  messagesByChannel: Record<string, T[]>,
  channelId: string,
  deletedId: string
): Record<string, T[]> {
  const messages = messagesByChannel[channelId];
  if (!messages) return messagesByChannel;

  const updated = messages
    .filter((m) => m.id !== deletedId)
    .map((m) =>
      m.reply_to_id === deletedId
        ? { ...m, referenced_message: { id: deletedId, author: null, content: null } }
        : m
    );

  return {
    ...messagesByChannel,
    [channelId]: updated,
  };
}

/**
 * Generic reaction-update handler. Replaces reaction list on a message.
 * Used by both handleReactionUpdate and handleDMReactionUpdate.
 */
export function updateReactionInRecord<
  T extends { id: string; reactions?: ReactionGroup[] }
>(
  messagesByChannel: Record<string, T[]>,
  channelId: string,
  messageId: string,
  reactions: ReactionGroup[]
): Record<string, T[]> {
  const messages = messagesByChannel[channelId];
  if (!messages) return messagesByChannel;

  return {
    ...messagesByChannel,
    [channelId]: messages.map((m) =>
      m.id === messageId ? { ...m, reactions } : m
    ),
  };
}

/**
 * Generic author-update handler. Patches author info across all cached messages.
 * Used by both handleAuthorUpdate and handleDMAuthorUpdate.
 *
 * @returns Updated record and whether any change occurred.
 */
export function updateAuthorInRecord<
  T extends { author?: { id: string } | null }
>(
  messagesByChannel: Record<string, T[]>,
  userId: string,
  patch: { display_name?: string | null; avatar_url?: string | null }
): { updated: Record<string, T[]>; changed: boolean } {
  const result: Record<string, T[]> = {};
  let changed = false;

  for (const [chId, msgs] of Object.entries(messagesByChannel)) {
    result[chId] = msgs.map((m) => {
      if (m.author?.id !== userId) return m;
      changed = true;
      return { ...m, author: { ...m.author, ...patch } };
    });
  }

  return { updated: result, changed };
}
