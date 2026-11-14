import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../types/message";
import * as storage from "./keyStorage";
import { cacheChannelMessage, channelMessageCacheEntry, readChannelMessageCache } from "./channelMessageCache";
vi.mock("./keyStorage", () => ({ getCachedDecryptedMessage: vi.fn(), cacheDecryptedMessage: vi.fn() }));
const source = { id: "m", channel_id: "channel", user_id: "owner", sender_device_id: "device",
  ciphertext: "authenticated-frame", e2ee_metadata: "metadata", created_at: "2026-11-14T00:00:00Z", attachments: [] } as unknown as Message;
beforeEach(() => vi.resetAllMocks());

describe("channel history cache", () => {
  it("restores the exact source without replaying its sender key", async () => {
    const entry = await channelMessageCacheEntry(source, { content: "restored history" });
    vi.mocked(storage.getCachedDecryptedMessage).mockResolvedValue(entry);
    expect(await readChannelMessageCache(source, () => true)).toEqual({ content: "restored history", file_keys: undefined });
    expect(entry.encryptedSourceTag).toMatch(/^channel-v1:[a-f0-9]{64}$/);
  });
  it.each([
    { id: "different" }, { channel_id: "different" }, { user_id: "different" },
    { sender_device_id: "different" }, { ciphertext: "edited-frame" }, { e2ee_metadata: "different" },
  ])("rejects a changed source: %j", async change => {
    vi.mocked(storage.getCachedDecryptedMessage).mockResolvedValue(await channelMessageCacheEntry(source, { content: "old" }));
    expect(await readChannelMessageCache({ ...source, ...change }, () => true)).toBeNull();
  });
  it("rejects a DM entry even when its source tag matches", async () => {
    vi.mocked(storage.getCachedDecryptedMessage).mockResolvedValue({ ...await channelMessageCacheEntry(source, { content: "foreign" }), dmChannelId: "dm" });
    expect(await readChannelMessageCache(source, () => true)).toBeNull();
  });
  it("does not treat an unversioned search cache as authenticated history", async () => {
    vi.mocked(storage.getCachedDecryptedMessage).mockResolvedValue({ ...await channelMessageCacheEntry(source, { content: "legacy" }), encryptedSourceTag: undefined });
    expect(await readChannelMessageCache(source, () => true)).toBeNull();
  });
  it("rejects attachment history without its file keys", async () => {
    vi.mocked(storage.getCachedDecryptedMessage).mockResolvedValue(await channelMessageCacheEntry(source, { content: "text" }));
    expect(await readChannelMessageCache({ ...source, attachments: [{ id: "attachment" }] } as Message, () => true)).toBeNull();
  });
  it("does not expose a cache result after an account change during the read", async () => {
    let current = true;
    const entry = await channelMessageCacheEntry(source, { content: "private" });
    vi.mocked(storage.getCachedDecryptedMessage).mockImplementation(async () => { current = false; return entry; });
    expect(await readChannelMessageCache(source, () => current)).toBeNull();
  });
  it("does not write plaintext after its owning session changes during hashing", async () => {
    let current = true;
    const pending = cacheChannelMessage(source, { content: "private" }, () => current);
    current = false;
    await pending;
    expect(storage.cacheDecryptedMessage).not.toHaveBeenCalled();
  });
});
