import { describe, expect, it, vi } from "vitest";
import type { Message } from "../types/message";
import { overlayDMSource, overlayGroupDMSource, projectOverlayChat, type OverlayChatProjectionInput, type OverlayChatSourceMessage } from "./overlayChat";
import type { DMMessage } from "../types/dm";
import type { GroupDMMessage } from "../types/groupDM";

function message(id: string, content: string | null, overrides: Partial<Message> = {}): Message {
  return {
    id, channel_id: "channel-1", user_id: `user-${id}`, content,
    edited_at: null, created_at: "2026-10-25T10:00:00Z", reply_to_id: null, referenced_message: null,
    author: { id: `user-${id}`, username: `handle-${id}`, display_name: `Author ${id}`, avatar_url: null, status: "online", custom_status: null, created_at: "2026-10-25T09:00:00Z" },
    attachments: [{ id: `attachment-${id}`, message_id: id, filename: "secret.txt", file_url: "https://example.test/private", file_size: 1, mime_type: "text/plain" }],
    mentions: ["someone"], role_mentions: ["role"], reactions: [], encryption_version: 0,
    ciphertext: "secret-ciphertext", sender_device_id: "secret-device", e2ee_metadata: "secret-metadata",
    ...overrides,
  };
}

function input(overrides: Partial<OverlayChatProjectionInput> = {}): OverlayChatProjectionInput {
  return {
    enabled: true, connected: true, currentOwnerId: "me", currentAuthGeneration: 4,
    ownerId: "me", authGeneration: 4, authorizationResolved: true, canView: true, canRead: true,
    channelId: "channel-1", messages: [message("one", "hello")], blockedUserIds: [], ignoredUserIds: [],
    isSpam: () => false, decryptionErrorMessageIds: [], ...overrides,
  };
}

describe("projectOverlayChat", () => {
  it("adapts private messages without copying crypto or attachment payloads", () => {
    const original = message("one", "hello");
    const dm = overlayDMSource({ ...original, dm_channel_id: "channel-1" } as unknown as DMMessage);
    const groupMessage = { ...original, group_id: "channel-1", user: original.author } as unknown as GroupDMMessage;
    for (const source of [dm, overlayGroupDMSource(groupMessage)]) {
      expect(Object.keys(source).sort()).toEqual(["author", "channel_id", "content", "edited_at", "id", "user_id"]);
      expect(projectOverlayChat(input({ messages: [source] })).chatMessages).toEqual([{ id: "one", author: "Author one", text: "hello" }]);
    }
    for (const source of [overlayGroupDMSource({ ...groupMessage, decryption_error: "version_unavailable" }), overlayGroupDMSource({ ...groupMessage, user: undefined })]) {
      expect(projectOverlayChat(input({ messages: [source] })).chatMessages).toEqual([]);
    }
  });
  it("fails closed when consent, connection, ownership, session, or read authorization is unresolved", () => {
    const bad: Partial<OverlayChatProjectionInput>[] = [
      { enabled: false }, { connected: false }, { currentOwnerId: null }, { ownerId: "other" },
      { authGeneration: -1 }, { currentAuthGeneration: 5 }, { authorizationResolved: false },
      { canView: false }, { canRead: false }, { channelId: null },
    ];
    for (const patch of bad) expect(projectOverlayChat(input(patch))).toEqual({ chatStatus: "unavailable", chatMessages: [] });
  });

  it("projects only bounded text fields and omits attachment, ciphertext, and message metadata", () => {
    const result = projectOverlayChat(input());
    expect(result).toEqual({ chatStatus: "ready", chatMessages: [{ id: "one", author: "Author one", text: "hello" }] });
    const serialized = JSON.stringify(result);
    for (const forbidden of ["https://", "secret.txt", "secret-ciphertext", "secret-device", "secret-metadata", "someone", "role"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps only the newest five eligible unique rows and returns them in timeline order", () => {
    const messages = Array.from({ length: 8 }, (_, index) => message(`m${index}`, `text ${index}`));
    messages.push(message("m7", "duplicate should not replace or duplicate"));
    expect(projectOverlayChat(input({ messages })).chatMessages.map((row) => row.id)).toEqual(["m3", "m4", "m5", "m6", "m7"]);
  });

  it("excludes cross-channel, empty/deleted, blocked, ignored, spam, and decryption-error rows", () => {
    const messages = [
      message("other-channel", "no", { channel_id: "channel-2" }),
      message("deleted", null), message("blank", " \n "),
      message("blocked", "no"), message("ignored", "no"), message("spam", "no"), message("decrypt", "no"),
      message("visible", "yes"),
    ];
    const isSpam = vi.fn((item: OverlayChatSourceMessage) => item.id === "spam");
    const result = projectOverlayChat(input({ messages, blockedUserIds: ["user-blocked"], ignoredUserIds: ["user-ignored"], isSpam, decryptionErrorMessageIds: new Set(["decrypt"]) }));
    expect(result.chatMessages).toEqual([{ id: "visible", author: "Author visible", text: "yes" }]);
    expect(isSpam).not.toHaveBeenCalledWith(expect.objectContaining({ id: "blocked" }));
  });

  it("omits any message with spoiler delimiters because the overlay has no reveal action", () => {
    const messages = [message("spoiler", "safe prefix ||private secret|| safe suffix"), message("unmatched", "unmatched || secret")];
    const result = projectOverlayChat(input({ messages }));
    expect(result).toEqual({ chatStatus: "ready", chatMessages: [] });
    expect(JSON.stringify(result)).not.toContain("private secret");
  });

  it("preserves own messages despite an ignored-user entry and sanitizes bounded text safely", () => {
    const own = message("own", `\u0001hello\u0000\nworld${"x".repeat(510)}`, { user_id: "me", author: { ...message("own", "").author, display_name: "", username: `me${"x".repeat(150)}` } });
    const result = projectOverlayChat(input({ messages: [own], ignoredUserIds: ["me"] }));
    expect(result.chatMessages).toHaveLength(1);
    expect(result.chatMessages[0].author).toBe(`me${"x".repeat(126)}`);
    expect(result.chatMessages[0].text).toHaveLength(500);
    expect(result.chatMessages[0].text).toMatch(/^hello\n/);
  });

  it("matches native UTF-16 bounds and sends single-line authors with normalized text line endings", () => {
    const source = message("astral", "line1\r\nline2\rline3", {
      author: { ...message("astral", "").author, display_name: "Display\r\nName" },
    });
    const astral = message("astral-500", "😀".repeat(500));
    const result = projectOverlayChat(input({ messages: [source, astral] }));
    expect(result.chatStatus).toBe("ready");
    expect(result.chatMessages).toHaveLength(2);
    expect(result.chatMessages[0].author).toBe("Display Name");
    expect(result.chatMessages[0].author.length).toBeLessThanOrEqual(128);
    expect(Array.from(result.chatMessages[0].author).every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)).toBe(true);
    expect(result.chatMessages[0].text).toBe("line1\nline2\nline3");
    expect(result.chatMessages[1].text).toBe("😀".repeat(250));
    expect(result.chatMessages[1].text.length).toBe(500);
  });

  it("uses username fallback, rejects invalid IDs, and suppresses a row if spam evaluation fails", () => {
    const fallback = message("fallback", "visible", { author: { ...message("fallback", "").author, display_name: "   " } });
    const control = message("bad\u0000id", "no");
    const throws = message("throws", "no");
    const result = projectOverlayChat(input({ messages: [fallback, control, throws], isSpam: (item) => { if (item.id === "throws") throw new Error("unknown"); return false; } }));
    expect(result.chatMessages).toEqual([{ id: "fallback", author: "handle-fallback", text: "visible" }]);
  });
});
