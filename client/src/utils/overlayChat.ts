import type { Message } from "../types/message";
import type { DMMessage } from "../types/dm";
import type { GroupDMMessage } from "../types/groupDM";

const MAX_MESSAGES = 5;
const MAX_ID_LENGTH = 128;
const MAX_AUTHOR_LENGTH = 128;
const MAX_TEXT_LENGTH = 500;

export type OverlayChatMessage = { id: string; author: string; text: string };
export type OverlayChatStatus = "ready" | "unavailable";
export type OverlayChatProjection = { chatStatus: OverlayChatStatus; chatMessages: OverlayChatMessage[] };

/** Only the fields consumed by the passive text projection, never crypto/file payloads. */
export type OverlayChatSourceMessage = Pick<Message, "id" | "channel_id" | "user_id" | "content" | "edited_at"> & {
  author?: Message["author"];
};

export function overlayDMSource(message: DMMessage): OverlayChatSourceMessage {
  return { id: message.id, channel_id: message.dm_channel_id, user_id: message.user_id,
    content: message.content, edited_at: message.edited_at, author: message.author };
}

export function overlayGroupDMSource(message: GroupDMMessage): OverlayChatSourceMessage {
  return { id: message.id, channel_id: message.group_id, user_id: message.user_id,
    content: message.decryption_error ? null : message.content, edited_at: message.edited_at, author: message.user };
}

export type OverlayChatProjectionInput = {
  enabled: boolean;
  connected: boolean;
  currentOwnerId: string | null;
  currentAuthGeneration: number;
  ownerId: string | null;
  authGeneration: number;
  authorizationResolved: boolean;
  canView: boolean;
  canRead: boolean;
  channelId: string | null;
  messages: readonly OverlayChatSourceMessage[];
  blockedUserIds: readonly string[];
  ignoredUserIds: readonly string[];
  isSpam: (message: OverlayChatSourceMessage) => boolean;
  decryptionErrorMessageIds: readonly string[] | ReadonlySet<string>;
};

const EMPTY: OverlayChatProjection = { chatStatus: "unavailable", chatMessages: [] };

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    && !Array.from(value).some((character) => isControl(character.codePointAt(0)!));
}

function isControl(code: number): boolean {
  return code <= 31 || (code >= 127 && code <= 159);
}

function cleanText(value: unknown, maxLength: number, singleLine = false): string | null {
  if (typeof value !== "string") return null;
  // Native validates UTF-16 code-unit length, so truncate on code-point
  // boundaries while counting each astral character as two code units.
  // Normalize line endings before bounding; author labels are single-line
  // because the native contract rejects control characters there.
  const normalized = singleLine
    ? value.replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ")
    : value.replace(/\r\n?/gu, "\n");
  const clean = Array.from(normalized).filter((character) => {
    const code = character.codePointAt(0)!;
    return (!isControl(code) || code === 9 || code === 10 || code === 13)
      && !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069);
  }).join("").trim();
  let bounded = "";
  for (const character of clean) {
    if (bounded.length + character.length > maxLength) break;
    bounded += character;
  }
  const cleaned = bounded.trim();
  return cleaned.length ? cleaned : null;
}

function hasDecryptionError(ids: OverlayChatProjectionInput["decryptionErrorMessageIds"], id: string): boolean {
  if (Array.isArray(ids)) return ids.includes(id);
  return typeof (ids as ReadonlySet<string>).has === "function" && (ids as ReadonlySet<string>).has(id);
}

/**
 * Build a bounded, text-only projection for the native overlay. This function
 * is deliberately synchronous and side-effect-free: it never fetches, records
 * spam, marks messages read, or exposes the source message object.
 */
export function projectOverlayChat(input: OverlayChatProjectionInput): OverlayChatProjection {
  if (!input.enabled || !input.connected || !input.currentOwnerId
    || input.ownerId !== input.currentOwnerId
    || !Number.isSafeInteger(input.authGeneration) || input.authGeneration < 0
    || input.authGeneration !== input.currentAuthGeneration
    || input.authorizationResolved !== true || input.canView !== true || input.canRead !== true
    || !isSafeId(input.channelId) || typeof input.isSpam !== "function"
    || !Array.isArray(input.messages) || !Array.isArray(input.blockedUserIds)
    || !Array.isArray(input.ignoredUserIds)
    || !(Array.isArray(input.decryptionErrorMessageIds) || input.decryptionErrorMessageIds instanceof Set)) {
    return EMPTY;
  }

  const blocked = new Set(input.blockedUserIds);
  const ignored = new Set(input.ignoredUserIds);
  const seen = new Set<string>();
  const result: OverlayChatMessage[] = [];

  // The source store keeps messages in ascending timeline order. Select the
  // newest eligible rows, then restore that same order for display.
  for (let index = input.messages.length - 1; index >= 0 && result.length < MAX_MESSAGES; index--) {
    const message = input.messages[index];
    if (!message || message.channel_id !== input.channelId || !isSafeId(message.id)
      || !isSafeId(message.user_id) || seen.has(message.id)
      || blocked.has(message.user_id)
      || (message.user_id !== input.currentOwnerId && ignored.has(message.user_id))
      || hasDecryptionError(input.decryptionErrorMessageIds, message.id)
      || typeof message.content !== "string"
      // The regular chat renderer hides ||spoiler|| spans. This projection
      // has no reveal interaction, so omit the whole message conservatively.
      || message.content.includes("||")) continue;

    let spam: boolean;
    try { spam = input.isSpam(message); }
    catch { continue; }
    if (typeof spam !== "boolean" || spam) continue;

    const author = cleanText(message.author?.display_name, MAX_AUTHOR_LENGTH, true)
      ?? cleanText(message.author?.username, MAX_AUTHOR_LENGTH, true);
    const text = cleanText(message.content, MAX_TEXT_LENGTH);
    if (!author || !text) continue;

    seen.add(message.id);
    result.push({ id: message.id, author, text });
  }

  result.reverse();
  return { chatStatus: "ready", chatMessages: result };
}
