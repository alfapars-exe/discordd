import type { Message } from "../types/message";
import type { E2EEPayload } from "./e2eePayload";
import type { CachedDecryptedMessage } from "./types";
import * as storage from "./keyStorage";
import { groupAttachmentKeyIndex } from "../utils/groupAttachmentKeys";

/** Source version for local cache reuse, not an additional sender-authentication claim. */
export async function channelMessageCacheTag(message: Message): Promise<string> {
  const source = JSON.stringify([message.channel_id, message.id, message.user_id,
    message.sender_device_id, message.ciphertext, message.e2ee_metadata ?? null]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return `channel-v1:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function channelMessageCacheEntry(message: Message, payload: E2EEPayload): Promise<CachedDecryptedMessage> {
  return {
    messageId: message.id, channelId: message.channel_id, dmChannelId: null,
    senderUserId: message.user_id, content: payload.content, fileKeys: payload.file_keys,
    encryptedSourceTag: await channelMessageCacheTag(message),
    timestamp: new Date(message.created_at).getTime(),
  };
}

export async function cacheChannelMessage(message: Message, payload: E2EEPayload, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return;
  const entry = await channelMessageCacheEntry(message, payload);
  if (!isCurrent()) return;
  await storage.cacheDecryptedMessage(entry, isCurrent);
}

export async function readChannelMessageCache(message: Message, isCurrent: () => boolean): Promise<E2EEPayload | null> {
  if (!isCurrent()) return null;
  const cached = await storage.getCachedDecryptedMessage(message.id);
  if (!isCurrent() || !cached || cached.messageId !== message.id || cached.channelId !== message.channel_id
    || cached.dmChannelId !== null || typeof cached.content !== "string") return null;
  const tag = await channelMessageCacheTag(message);
  if (!isCurrent() || cached.encryptedSourceTag !== tag) return null;
  for (const [position, attachment] of (message.attachments ?? []).entries()) {
    const index = groupAttachmentKeyIndex(attachment, position);
    if (index === undefined || !Array.isArray(cached.fileKeys) || !cached.fileKeys[index]) return null;
  }
  return { content: cached.content, file_keys: cached.fileKeys };
}
