import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { afterEach, beforeEach, expect, it } from "vitest";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import { cacheDecryptedMessage, cacheDecryptedMessages, closeDB } from "./keyStorage";
import { scanCachedSearchReferences, SEARCH_REFERENCE_BATCH_SIZE } from "./cachedSearchScan";
import { getDB } from "./keyDatabase";
import { CACHED_SEARCH_EPOCH_KEY } from "./cachedSearchEpoch";
import { reserveCachedMessageDeletion } from "./cachedMessageDeletions";
import { deleteCachedChannelMessage, deleteCachedDMMessage } from "./keyStorage";
import type { CachedDecryptedMessage } from "./types";

let generation = 0;
beforeEach(async () => {
  await closeDB(); globalThis.indexedDB = new IDBFactory();
  publishAuthOwnerChange("search-owner"); publishAuthGenerationChange(++generation);
});
afterEach(async () => { await closeDB(); });
const row = (index: number): CachedDecryptedMessage => ({
  messageId: `message-${String(index).padStart(4, "0")}`, channelId: "channel", dmChannelId: "dm",
  timestamp: index, content: "Été private plaintext", sourceSequence: String(9007199254740992n + BigInt(index)),
});
it.each(["channel", "dm"] as const)("starts %s source reads after accepted deletion cleanup settles", async kind => {
  const message = { ...row(0), channelId: kind === "channel" ? "channel" : "", dmChannelId: kind === "channel" ? null : "dm" };
  await cacheDecryptedMessage(message);
  const channel = kind === "channel" ? "channel" : "dm";
  const finish = reserveCachedMessageDeletion(kind, channel);
  const scan = scanCachedSearchReferences(kind, channel, "ÉTÉ", async () => {});
  try {
    // Give an unguarded read the opportunity to observe the still-cached row.
    await new Promise(resolve => setTimeout(resolve, 20));
    if (kind === "channel") await deleteCachedChannelMessage(message.messageId, channel, () => true);
    else await deleteCachedDMMessage(message.messageId, channel, () => true);
  } finally { finish(); }
  expect(await scan).toBe(0);
});
it.each(["channel", "dm"] as const)("streams %s matches with bounded batches and no plaintext", async kind => {
  await cacheDecryptedMessages(Array.from({ length: 1000 }, (_, i) => row(i)));
  let count = 0, peak = 0;
  const sizes: number[] = [];
  const found = await scanCachedSearchReferences(kind, kind === "dm" ? "dm" : "channel", "ÉTÉ", async batch => {
    sizes.push(batch.length); peak = Math.max(peak, batch.length);
    for (const ref of batch) {
      expect(ref).toEqual({ messageId: row(count).messageId, timestamp: count, sourceSequence: row(count).sourceSequence });
      expect(ref).not.toHaveProperty("content"); count++;
    }
  });
  expect(found).toBe(1000); expect(count).toBe(1000);
  expect(peak).toBe(SEARCH_REFERENCE_BATCH_SIZE);
  expect(sizes).toEqual([128,128,128,128,128,128,128,104]);
});
it("keeps a coherent source transaction while a separate index commits", async () => {
  await cacheDecryptedMessages(Array.from({ length: 260 }, (_, i) => row(i)));
  const sidecar = await openDB("test-search-sidecar", 1, { upgrade(db) { db.createObjectStore("refs"); } });
  let written = 0;
  try {
    expect(await scanCachedSearchReferences("dm", "dm", "ÉTÉ", async batch => {
      const tx = sidecar.transaction("refs", "readwrite");
      for (const ref of batch) await tx.store.put(ref, ref.messageId);
      await tx.done; written += batch.length;
    })).toBe(260);
    expect(written).toBe(260); expect(await sidecar.count("refs")).toBe(260);
  } finally { sidecar.close(); }
});
it("does not mix a cache edit committed during consumer backpressure", async () => {
  await cacheDecryptedMessages(Array.from({ length: 260 }, (_, i) => row(i)));
  let edit: Promise<void> | undefined;
  let seenLast = false;
  expect(await scanCachedSearchReferences("dm", "dm", "ÉTÉ", async batch => {
    if (!edit) edit = cacheDecryptedMessage({ ...row(259), content: "no longer matches" });
    // A separate event turn would close an unprotected source transaction.
    await new Promise(resolve => setTimeout(resolve, 5));
    if (batch.some(ref => ref.messageId === row(259).messageId)) seenLast = true;
  })).toBe(260);
  expect(seenLast).toBe(true); await edit;
  expect(await scanCachedSearchReferences("dm", "dm", "ÉTÉ", async () => {})).toBe(259);
});
it("stops on cancellation during a pending consumer", async () => {
  await cacheDecryptedMessages(Array.from({ length: 260 }, (_, i) => row(i)));
  const controller = new AbortController(); let batches = 0;
  await expect(scanCachedSearchReferences("dm", "dm", "ÉTÉ", async () => {
    batches++; controller.abort();
  }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(batches).toBe(1);
});
it("rejects a consumer failure and releases source writes", async () => {
  await cacheDecryptedMessages(Array.from({ length: 260 }, (_, i) => row(i)));
  await expect(scanCachedSearchReferences("dm", "dm", "ÉTÉ", async () => { throw new Error("sidecar quota"); })).rejects.toThrow("sidecar quota");
  await cacheDecryptedMessage(row(300));
});
it("rejects account changes while the consumer awaits", async () => {
  await cacheDecryptedMessages(Array.from({ length: 260 }, (_, i) => row(i)));
  await expect(scanCachedSearchReferences("dm", "dm", "ÉTÉ", async () => {
    publishAuthOwnerChange("another-owner");
  })).rejects.toThrow();
});
it("ignores nonmatching and foreign-conversation cache records", async () => {
  await cacheDecryptedMessages([{ ...row(1), content: "other" }, { ...row(2), channelId:"other", dmChannelId:"other" }]);
  let calls = 0;
  expect(await scanCachedSearchReferences("dm", "dm", "ÉTÉ", async () => { calls++; })).toBe(0);
  expect(calls).toBe(0);
});

it("does not hold a metadata lock while streaming message references", async () => {
  await cacheDecryptedMessages(Array.from({length:260},(_,i)=>row(i)));
  let wrote=false;
  expect(await scanCachedSearchReferences("dm","dm","ÉTÉ",async()=>{
    if(wrote)return;const db=await getDB();await db.put("metadata","completed","unrelated-state");wrote=true;
  })).toBe(260);
  expect(wrote).toBe(true);
});
it("rejects a source reset that commits immediately after its read transaction", async () => {
  await cacheDecryptedMessages(Array.from({length:260},(_,i)=>row(i)));
  let reset:Promise<void>|undefined;
  const pending=scanCachedSearchReferences("dm","dm","ÉTÉ",async()=>{
    if(reset)return;
    reset=(async()=>{const db=await getDB(),tx=db.transaction(["messageCache","metadata"],"readwrite");
      await tx.objectStore("messageCache").clear();await tx.objectStore("metadata").put(crypto.randomUUID(),CACHED_SEARCH_EPOCH_KEY);await tx.done;
    })();
  });
  await expect(pending).rejects.toThrow("search_cache_epoch_changed");await reset;
});

it("aborts the native reader on same-account session replacement", async () => {
  await cacheDecryptedMessages(Array.from({length:260},(_,i)=>row(i)));
  let batches=0;
  await expect(scanCachedSearchReferences("dm","dm","ÉTÉ",async()=>{
    batches++;publishAuthGenerationChange(++generation);
  })).rejects.toThrow("e2ee_account_scope_changed");
  expect(batches).toBe(1);
});

// Cancellation must release the source lock without waiting for a stalled
// sidecar consumer, including when that consumer eventually rejects.
it.each(["cancel", "session"] as const)("releases queued cache writes on %s while the consumer is stalled", async reason => {
  await cacheDecryptedMessages(Array.from({ length: 260 }, (_, i) => row(i)));
  const controller = new AbortController();
  let entered!: () => void, rejectConsumer!: (error: Error) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const stalled = new Promise<void>((_, reject) => { rejectConsumer = reject; });
  let batches = 0;
  const scan = scanCachedSearchReferences("dm", "dm", "ÉTÉ", () => {
    batches++; entered(); return stalled;
  }, controller.signal);
  const rejected = expect(scan).rejects.toThrow(reason === "cancel" ? /abort/i : "e2ee_account_scope_changed");
  await started;
  const db = await getDB();
  const tx = db.transaction("messageCache", "readwrite");
  const write = tx.store.put(row(300));
  let committed = false;
  const completion = tx.done.then(() => { committed = true; });
  // Session replacement also fences queued writes made by the old session.
  const written = Promise.allSettled([write, completion]);
  try {
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(committed).toBe(false);
    if (reason === "cancel") controller.abort();
    else publishAuthGenerationChange(++generation);
    await rejected;
    const outcomes = await written;
    if (reason === "cancel") {
      expect(outcomes.every(result => result.status === "fulfilled")).toBe(true);
      expect(committed).toBe(true);
    } else {
      expect(outcomes.every(result => result.status === "rejected")).toBe(true);
      expect(committed).toBe(false);
      // Fresh-session writes must no longer wait on the abandoned reader.
      await cacheDecryptedMessage(row(301));
    }
    expect(batches).toBe(1);
    rejectConsumer(new Error("late sidecar failure"));
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    controller.abort(); rejectConsumer(new Error("test cleanup"));
    await Promise.allSettled([scan, write, completion]);
  }
});
