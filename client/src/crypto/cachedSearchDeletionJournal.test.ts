import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAuthSessionSnapshot, publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import * as storage from "./keyStorage";
import { getDB } from "./keyDatabase";
import { createCachedSearchSnapshot, type CachedSearchSnapshot } from "./cachedSearchSnapshot";
import { cachedSearchDeletionKey, scanPendingCachedSearchDeletions } from "./cachedSearchDeletionJournal";

const live: CachedSearchSnapshot[] = [];
beforeEach(async () => {
  await storage.closeDB(); globalThis.indexedDB = new IDBFactory();
  publishAuthOwnerChange("pending-deletion-owner");
  publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(live.splice(0).map(item => item.dispose())); await storage.closeDB(); });

async function failedCleanup(kind: "channel" | "dm") {
  const scope = { channelId: kind === "channel" ? "room" : "", dmChannelId: kind === "dm" ? "room" : null };
  const deleted = { ...scope, messageId: "deleted", content: "deleted plaintext", timestamp: 2, sourceSequence: "2" };
  await storage.cacheDecryptedMessages([deleted, { ...scope, messageId: "kept", content: "kept plaintext", timestamp: 1, sourceSequence: "1" }]);
  const original = IDBObjectStore.prototype.delete;
  const failure = new DOMException("Synthetic cache cleanup failure", "UnknownError");
  const hook = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, key) {
    if (this.name === "messageCache" && key === "deleted") throw failure;
    return original.call(this, key);
  });
  try {
    const deleting = kind === "channel" ? storage.deleteCachedChannelMessage("deleted", "room", () => true) : storage.deleteCachedDMMessage("deleted", "room", () => true);
    await expect(deleting).rejects.toBe(failure);
  } finally { hook.mockRestore(); }
  // The test must exercise failed physical eviction, not an already empty cache.
  expect(await (await getDB()).get("messageCache", "deleted")).toEqual(deleted);
}

for (const kind of ["channel", "dm"] as const) {
  it(`${kind}: hides a durably pending deletion from point reads after cache cleanup fails`, async () => {
    await failedCleanup(kind);
    expect(await storage.getCachedDecryptedMessage("deleted")).toBeNull();
    expect((await storage.getCachedDecryptedMessage("kept"))?.content).toBe("kept plaintext");
  });

  it(`${kind}: excludes a pending deletion from a fresh index and exact total after reopening`, async () => {
    await failedCleanup(kind);
    await storage.closeDB(); publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
    const snapshot = await createCachedSearchSnapshot(kind, "room", "plaintext"); live.push(snapshot);
    expect(await snapshot.page(0, 25)).toEqual({ ids: ["kept"], offset: 0, total: 1 });
  });

  it(`${kind}: excludes a pending deletion from legacy searches and backup cache contents`, async () => {
    await failedCleanup(kind);
    const search = kind === "channel" ? storage.searchCachedMessages : storage.searchCachedDMMessages;
    const refs = kind === "channel" ? storage.searchCachedMessageRefs : storage.searchCachedDMMessageRefs;
    expect(await search("room", "deleted")).toEqual([]);
    expect(await refs("room", "deleted")).toEqual([]);
    expect((await storage.getAllCachedMessages()).map(row => row.messageId)).toEqual(["kept"]);
  });

  it(`${kind}: removes the durable intent only when a retry commits physical eviction`, async () => {
    await failedCleanup(kind);
    const key = cachedSearchDeletionKey(kind, "room", "deleted");
    expect(await (await getDB()).get("metadata", key)).toMatchObject({ messageId: "deleted", writeToken: expect.any(String) });
    const removed = kind === "channel" ? await storage.deleteCachedChannelMessage("deleted", "room", () => true) : await storage.deleteCachedDMMessage("deleted", "room", () => true);
    expect(removed).toBe(true);
    expect(await (await getDB()).get("messageCache", "deleted")).toBeUndefined();
    expect(await (await getDB()).get("metadata", key)).toBeUndefined();
  });

  it(`${kind}: rolls back eviction if retiring its durable intent fails`, async () => {
    await failedCleanup(kind);
    const original = IDBObjectStore.prototype.delete, key = cachedSearchDeletionKey(kind, "room", "deleted");
    const hook = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, recordKey) {
      if (this.name === "metadata" && recordKey === key) throw new DOMException("Synthetic intent retirement failure", "UnknownError");
      return original.call(this, recordKey);
    });
    try {
      const deleting = kind === "channel" ? storage.deleteCachedChannelMessage("deleted", "room", () => true) : storage.deleteCachedDMMessage("deleted", "room", () => true);
      await expect(deleting).rejects.toMatchObject({ name: "UnknownError" });
    } finally { hook.mockRestore(); }
    expect((await (await getDB()).get("messageCache", "deleted"))?.content).toBe("deleted plaintext");
    expect(await (await getDB()).get("metadata", key)).toMatchObject({ messageId: "deleted", writeToken: expect.any(String) });
    expect(await storage.getCachedDecryptedMessage("deleted")).toBeNull();
  });

  it(`${kind}: still attempts physical eviction when recording the durable intent fails`, async () => {
    const scope = { channelId: kind === "channel" ? "room" : "", dmChannelId: kind === "dm" ? "room" : null };
    await storage.cacheDecryptedMessage({ ...scope, messageId: "deleted", content: "cached", timestamp: 1 });
    const original = IDBObjectStore.prototype.put, key = cachedSearchDeletionKey(kind, "room", "deleted");
    const failure = new DOMException("Synthetic journal write failure", "QuotaExceededError");
    const hook = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "metadata" && args[1] === key) throw failure;
      return original.apply(this, args);
    });
    try {
      const deleting = kind === "channel" ? storage.deleteCachedChannelMessage("deleted", "room", () => true) : storage.deleteCachedDMMessage("deleted", "room", () => true);
      await expect(deleting).resolves.toBe(true);
    } finally { hook.mockRestore(); }
    expect(await (await getDB()).get("messageCache", "deleted")).toBeUndefined();
  });
}

it("streams durable deletion IDs in bounded batches without holding metadata across the consumer", async () => {
  const db = await getDB(), seed = db.transaction("metadata", "readwrite");
  for (let i = 0; i < 257; i++) await seed.store.put({ messageId: String(i) }, cachedSearchDeletionKey("dm", "room", String(i)));
  await seed.done;
  const sizes: number[] = [], seen = new Set<string>();
  await scanPendingCachedSearchDeletions("dm", "room", async ids => {
    sizes.push(ids.length); for (const id of ids) seen.add(id);
    await db.put("metadata", true, "consumer-write");
  });
  expect(sizes).toEqual([128, 128, 1]); expect(seen.size).toBe(257);
  expect(await db.get("metadata", "consumer-write")).toBe(true);
  expect((await db.getAllKeys("metadata")).filter(key => typeof key === "string" && key.startsWith("cached-search-delete.v1:"))).toEqual([]);
});

it("rejects a malformed durable intent instead of hiding a valid row as an empty result", async () => {
  await storage.cacheDecryptedMessage({ messageId: "corrupt", channelId: "room", dmChannelId: null, content: "cached", timestamp: 1 });
  await (await getDB()).put("metadata", { messageId: "wrong" }, cachedSearchDeletionKey("channel", "room", "corrupt"));
  await expect(storage.getCachedDecryptedMessage("corrupt")).rejects.toThrow("search_deletion_journal_invalid");
  await expect(createCachedSearchSnapshot("channel", "room", "cached")).rejects.toThrow("search_deletion_journal_invalid");
});

it("does not write an intent when the deletion context is already retired", async () => {
  await storage.cacheDecryptedMessage({ messageId: "retained", channelId: "room", dmChannelId: null, content: "cached", timestamp: 1 });
  expect(await storage.deleteCachedChannelMessage("retained", "room", () => false)).toBe(false);
  expect(await (await getDB()).getAllKeys("metadata")).toEqual([]);
  expect((await storage.getCachedDecryptedMessage("retained"))?.content).toBe("cached");
});

it.each(["channel", "dm"] as const)("keeps the newer %s intent when an older concurrent eviction commits", async kind => {
  const scope = { channelId: kind === "channel" ? "room" : "", dmChannelId: kind === "dm" ? "room" : null };
  const row = { ...scope, messageId: "concurrent", content: "stale plaintext", timestamp: 1 };
  await storage.cacheDecryptedMessage(row);
  const original = IDBObjectStore.prototype.get, failure = new DOMException("Second cleanup failed", "UnknownError");
  let reads = 0;
  const hook = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key) {
    if (this.name === "messageCache" && ++reads === 2) throw failure;
    return original.call(this, key);
  });
  const remove = () => kind === "channel" ? storage.deleteCachedChannelMessage("concurrent", "room", () => true) : storage.deleteCachedDMMessage("concurrent", "room", () => true);
  try {
    const results = await Promise.allSettled([remove(), remove()]);
    expect(results[0]).toEqual({ status: "fulfilled", value: true });
    expect(results[1]).toEqual({ status: "rejected", reason: failure });
  } finally { hook.mockRestore(); }
  expect(await (await getDB()).get("metadata", cachedSearchDeletionKey(kind, "room", "concurrent"))).toMatchObject({ messageId: "concurrent" });
  await storage.cacheDecryptedMessage(row);
  expect(await storage.getCachedDecryptedMessage("concurrent")).toBeNull();
});

it("retains both storage failures when neither durable intent nor physical eviction commits", async () => {
  await storage.cacheDecryptedMessage({ messageId: "failed", channelId: "room", dmChannelId: null, content: "cached", timestamp: 1 });
  const journalFailure = new DOMException("Journal failed", "QuotaExceededError"), evictionFailure = new DOMException("Eviction failed", "UnknownError");
  const originalPut = IDBObjectStore.prototype.put, originalDelete = IDBObjectStore.prototype.delete;
  const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "metadata") throw journalFailure;
    return originalPut.apply(this, args);
  });
  const remove = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, key) {
    if (this.name === "messageCache") throw evictionFailure;
    return originalDelete.call(this, key);
  });
  try {
    await expect(storage.deleteCachedChannelMessage("failed", "room", () => true)).rejects.toMatchObject({
      name: "AggregateError", errors: [journalFailure, evictionFailure], cause: evictionFailure,
    });
  } finally { put.mockRestore(); remove.mockRestore(); }
  expect((await (await getDB()).get("messageCache", "failed"))?.content).toBe("cached");
});

it.each(["owner", "generation"] as const)("rejects a %s change during the final journal batch consumer", async boundary => {
  await (await getDB()).put("metadata", { messageId: "pending" }, cachedSearchDeletionKey("dm", "room", "pending"));
  await expect(scanPendingCachedSearchDeletions("dm", "room", async () => {
    if (boundary === "owner") publishAuthOwnerChange("replacement");
    else publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
  })).rejects.toThrow("e2ee_account_scope_changed");
});

it("observes cancellation after a bounded journal batch consumer", async () => {
  await (await getDB()).put("metadata", { messageId: "pending" }, cachedSearchDeletionKey("dm", "room", "pending"));
  const controller = new AbortController();
  await expect(scanPendingCachedSearchDeletions("dm", "room", async () => { controller.abort(); }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("does not add a metadata point request per cached row during backup collection", async () => {
  await failedCleanup("channel");
  await storage.cacheDecryptedMessages(Array.from({ length: 1000 }, (_, i) => ({ messageId: `bulk-${i}`, channelId: "room", dmChannelId: null, content: "cached", timestamp: i })));
  const original = IDBObjectStore.prototype.get;
  let metadataReads = 0;
  const hook = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key) {
    if (this.name === "metadata") metadataReads++;
    return original.call(this, key);
  });
  try {
    const rows = await storage.getAllCachedMessages();
    expect(rows).toHaveLength(1001); expect(rows.some(row => row.messageId === "deleted")).toBe(false);
    expect(metadataReads).toBeLessThanOrEqual(2);
  } finally { hook.mockRestore(); }
});

it("rolls back orphan retirement when a later intent in the same batch is malformed", async () => {
 const db = await getDB();
 const orphan = cachedSearchDeletionKey("dm", "room", "a");
 const corrupt = cachedSearchDeletionKey("dm", "room", "z");
 await db.put("metadata", { messageId: "a" }, orphan);
 await db.put("metadata", { messageId: "wrong" }, corrupt);
 const consume = vi.fn(async () => {});
 await expect(scanPendingCachedSearchDeletions("dm", "room", consume)).rejects.toThrow("search_deletion_journal_invalid");
 expect(consume).not.toHaveBeenCalled();
 expect(await db.get("metadata", orphan)).toEqual({ messageId: "a" });
 expect(await db.get("metadata", corrupt)).toEqual({ messageId: "wrong" });
});
it("keeps kind and escaped channel boundaries separate during intent scans", async () => {
 const db = await getDB();
 await db.put("metadata", { messageId: "wanted:/" }, cachedSearchDeletionKey("dm", "room:/", "wanted:/"));
 const otherKind = cachedSearchDeletionKey("channel", "room:/", "other-kind");
 const otherRoom = cachedSearchDeletionKey("dm", "room", "other-room");
 await db.put("metadata", { messageId: "other-kind" }, otherKind);
 await db.put("metadata", { messageId: "other-room" }, otherRoom);
 const consume = vi.fn(async () => {});
 await scanPendingCachedSearchDeletions("dm", "room:/", consume);
 expect(consume).toHaveBeenCalledExactlyOnceWith(["wanted:/"]);
 expect(await db.get("metadata", otherKind)).toEqual({ messageId: "other-kind" });
 expect(await db.get("metadata", otherRoom)).toEqual({ messageId: "other-room" });
});
it("propagates consumer failure after closing the committed batch", async () => {
 const db = await getDB();
 const key = cachedSearchDeletionKey("dm", "room", "orphan");
 await db.put("metadata", { messageId: "orphan" }, key);
 const failure = new Error("sidecar-unavailable");
 await expect(scanPendingCachedSearchDeletions("dm", "room", async () => {
  await db.put("metadata", true, "consumer-committed");
  throw failure;
 })).rejects.toBe(failure);
 expect(await db.get("metadata", key)).toBeUndefined();
 expect(await db.get("metadata", "consumer-committed")).toBe(true);
});
