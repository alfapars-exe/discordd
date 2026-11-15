import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAuthSessionSnapshot, publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import * as storage from "./keyStorage";
import { getDB } from "./keyDatabase";
import { createCachedSearchSnapshot, type CachedSearchSnapshot } from "./cachedSearchSnapshot";

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
}
