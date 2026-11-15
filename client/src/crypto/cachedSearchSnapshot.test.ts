import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import { SERVER_URL } from "../utils/constants";
import { sortDMBySource } from "../utils/dmSourceOrder";
import { cacheDecryptedMessages, clearAllE2EEData, closeDB, getAccountDatabaseName, getAllMetadata } from "./keyStorage";
import { createCachedSearchSnapshot, SEARCH_SNAPSHOT_MAX_AGE_MS, type CachedSearchSnapshot, withResetCachedSearchSnapshots } from "./cachedSearchSnapshot";
import { getDB } from "./keyDatabase";
import { CACHED_SEARCH_EPOCH_KEY, getCachedSearchEpoch } from "./cachedSearchEpoch";
import type { CachedDecryptedMessage } from "./types";
let generation = 0;
const live: CachedSearchSnapshot[] = [];
beforeEach(async () => {
  await closeDB(); globalThis.indexedDB = new IDBFactory();
  publishAuthOwnerChange("snapshot-owner"); publishAuthGenerationChange(++generation);
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(live.splice(0).map(item => item.dispose())); await closeDB(); });
const row = (id: string, timestamp: number, sourceSequence?: string): CachedDecryptedMessage => ({ messageId:id, timestamp, sourceSequence, channelId:"channel",dmChannelId:"dm",content:"Été" });
async function create(kind: "dm" | "channel" = "dm") { const snapshot = await createCachedSearchSnapshot(kind, kind === "dm" ? "dm" : "channel", "ÉTÉ"); live.push(snapshot); return snapshot; }
it.each(["channel", "dm"] as const)("paginates %s references without exposing all IDs", async kind => {
  const rows = Array.from({length: 300},(_,i)=>row(String(i).padStart(4,"0"),i,String(9007199254740992n+BigInt(300-i))));
  await cacheDecryptedMessages(rows);
  const snapshot = await create(kind);
  const expected = kind === "channel" ? [...rows].reverse().map(row=>row.messageId) : rows.map(row=>row.messageId);
  for (const offset of [0,25,275,0,25]) {
    const page = await snapshot.page(offset,25);
    expect(page).toEqual({ids:expected.slice(offset,offset+25),offset,total:300});
  }
  expect(await snapshot.page(9999,25)).toEqual({ids:expected.slice(275),offset:275,total:300});
});
it.each(["channel", "dm"] as const)("preserves every %s page across a large staging boundary and final tail", async kind => {
  const rows = Array.from({length:1201},(_,i)=>row(String(i).padStart(4,"0"),i,String(9007199254740992n+BigInt(1201-i))));
  await cacheDecryptedMessages(rows);
  const snapshot = await create(kind);
  const expected = kind === "channel" ? [...rows].reverse().map(item=>item.messageId) : rows.map(item=>item.messageId);
  for (const offset of [0,1000,1024,1200]) {
    expect(await snapshot.page(offset,25)).toEqual({ids:expected.slice(offset,offset+25),offset,total:1201});
  }
});

it("preserves a large mixed DM history across staging boundaries", async () => {
  const rows=Array.from({length:1201},(_,i)=>row(String(i).padStart(4,"0"),i,i%5===0?undefined:String(9007199254740992n+BigInt(1201-i))));
  await cacheDecryptedMessages(rows);const snapshot=await create();
  const expected=sortDMBySource(rows.map(item=>({id:item.messageId,created_at:new Date(item.timestamp).toISOString(),source_sequence:item.sourceSequence}))).reverse().map(item=>item.id);
  for(const offset of [0,1000,1024,1200])expect(await snapshot.page(offset,25)).toEqual({ids:expected.slice(offset,offset+25),offset,total:1201});
// The isolated 1,201-row fake IndexedDB rank fixture takes about 6.4s.
},20_000);

it("cleans a synchronous quota failure during a large staged write and can retry", async () => {
  await cacheDecryptedMessages(Array.from({length:1201},(_,i)=>row(String(i).padStart(4,"0"),i)));
  const original=IDBObjectStore.prototype.put;let writes=0;
  const spy=vi.spyOn(IDBObjectStore.prototype,"put").mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore["put"]>){
    if(this.name==="refs"&&++writes===300)throw new DOMException("synthetic quota failure","QuotaExceededError");
    return original.apply(this,args);
  });
  try{await expect(createCachedSearchSnapshot("dm","dm","ÉTÉ")).rejects.toMatchObject({name:"QuotaExceededError"});}
  finally{spy.mockRestore();}
  await assertNoLeakedIndex();
  const recovered=await create();expect((await recovered.page(1200,25)).ids).toEqual(["0000"]);
});

it("preserves mixed legacy slots and exact BIGINT/timestamp ties", async () => {
  const rows = [row("a",1,"9007199254740993"),row("b",2),row("c",3,"9007199254740992"),row("d",3,"9007199254740994"),row("e",3)];
  await cacheDecryptedMessages(rows);
  const snapshot = await create();
  const expected = sortDMBySource(rows.map(row=>({id:row.messageId,created_at:new Date(row.timestamp).toISOString(),source_sequence:row.sourceSequence}))).reverse().map(row=>row.id);
  expect((await snapshot.page(0,25)).ids).toEqual(expected);
  expect(await snapshot.remove("c")).toEqual({removed:true,position:expected.indexOf("c"),total:4});
  expect((await snapshot.page(0,25)).ids).toEqual(expected.filter(id=>id!=="c"));
  expect(await snapshot.remove("c")).toEqual({removed:false,total:4});
});
it("retains channel timestamp tie order from the source index", async () => {
  await cacheDecryptedMessages([row("b",2),row("a",2),row("c",1)]);
  const snapshot = await create("channel");
  expect((await snapshot.page(0,25)).ids).toEqual(["a","b","c"]);
});
it("refills and clamps a last page after deletion", async () => {
  await cacheDecryptedMessages(Array.from({length:26},(_,i)=>row(String(i).padStart(2,"0"),i)));
  const snapshot = await create();
  expect((await snapshot.page(25,25)).ids).toEqual(["00"]);
  expect(await snapshot.remove("00")).toEqual({removed:true,position:25,total:25});
  const page = await snapshot.page(25,25); expect(page.offset).toBe(0); expect(page.ids).toHaveLength(25); expect(page.total).toBe(25);
});
it("isolates concurrent snapshots and disposes only its own metadata", async () => {
  await cacheDecryptedMessages([row("a",1)]);
  const left=await create(), right=await create();
  await left.dispose(); await left.dispose();
  await expect(left.page(0,25)).rejects.toThrow("search_snapshot_disposed");
  expect((await right.page(0,25)).ids).toEqual(["a"]);
  const db=await openDB(`${await getAccountDatabaseName("snapshot-owner",SERVER_URL)}.search.v1`,1);
  expect(await db.count("snapshots")).toBe(1);expect(await db.count("refs")).toBe(1);db.close();
});
it("sweeps expired abandoned snapshots without touching newer ones", async () => {
  await cacheDecryptedMessages([row("a",1)]);
  const old=await create();
  const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+SEARCH_SNAPSHOT_MAX_AGE_MS+1);
  const current=await create();
  await expect(old.page(0,25)).rejects.toThrow("search_snapshot_expired");
  expect((await current.page(0,25)).ids).toEqual(["a"]);
});
it("denies a handle after logout and does not expose it to another account", async () => {
  await cacheDecryptedMessages([row("a",1)]);const snapshot=await create();
  publishAuthOwnerChange("another-account");
  await expect(snapshot.page(0,25)).rejects.toThrow();
  const other=await create();expect((await other.page(0,25)).ids).toEqual([]);
});
it("rejects already canceled creation and invalid page sizes", async () => {
  const controller=new AbortController();controller.abort();
  await expect(createCachedSearchSnapshot("dm","dm","ÉTÉ",controller.signal)).rejects.toMatchObject({name:"AbortError"});
  const snapshot=await create();
  for(const [offset,limit] of [[-1,25],[0,0],[0,129],[1.1,25]])await expect(snapshot.page(offset,limit)).rejects.toThrow("search_snapshot_invalid_page");
  await expect(snapshot.page(0,25,controller.signal)).rejects.toMatchObject({name:"AbortError"});
});

it("preserves duplicate authoritative and invalid legacy sequence ordering", async () => {
  const rows=[row("a",1,"2"),row("b",2,"2"),row("c",0,"0"),row("d",7,"9223372036854775808")];
  await cacheDecryptedMessages(rows);const snapshot=await create();
  const expected=sortDMBySource(rows.map(row=>({id:row.messageId,created_at:new Date(row.timestamp).toISOString(),source_sequence:row.sourceSequence}))).reverse().map(row=>row.id);
  expect((await snapshot.page(0,25)).ids).toEqual(expected);
});
async function assertNoLeakedIndex() {
  const db=await openDB(`${await getAccountDatabaseName("snapshot-owner",SERVER_URL)}.search.v1`,1);
  try {for(const store of ["refs","snapshots"])expect(await db.count(store)).toBe(0);}
  finally {db.close();}
}
it("cleans a partial index when creation is canceled during staging", async () => {
  await cacheDecryptedMessages(Array.from({length:300},(_,i)=>row(String(i).padStart(4,"0"),i)));
  const controller=new AbortController();let writes=0;
  const original=IDBObjectStore.prototype.put;
  const spy=vi.spyOn(IDBObjectStore.prototype,"put").mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore["put"]>){
    const result=original.apply(this,args);
    if(this.name==="refs"&&++writes===20)controller.abort();
    return result;
  });
  try {await expect(createCachedSearchSnapshot("dm","dm","ÉTÉ",controller.signal)).rejects.toThrow();}
  finally {spy.mockRestore();}
  expect(writes).toBeGreaterThanOrEqual(20);await assertNoLeakedIndex();
});
it("rejects invalid cached ordering data without orphaned write rejections", async () => {
  await cacheDecryptedMessages([row("a",1),row("b",Number.NaN),row("c",3)]);
  await expect(createCachedSearchSnapshot("dm","dm","ÉTÉ")).rejects.toThrow("search_snapshot_invalid_timestamp");
  await assertNoLeakedIndex();
});

it("rejects an old handle after same-account session replacement", async () => {
  await cacheDecryptedMessages([row("a",1)]);const snapshot=await create();
  publishAuthGenerationChange(++generation);
  await expect(snapshot.page(0,25)).rejects.toThrow();
  await snapshot.dispose();await assertNoLeakedIndex();
  const replacement=await create();expect((await replacement.page(0,25)).ids).toEqual(["a"]);
});
it("rolls back both deletion and total count when an in-flight removal is canceled", async () => {
  await cacheDecryptedMessages([row("a",1),row("b",2)]);const snapshot=await create();
  const controller=new AbortController(),original=IDBObjectStore.prototype.delete;
  const spy=vi.spyOn(IDBObjectStore.prototype,"delete").mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore["delete"]>){
    const result=original.apply(this,args);if(this.name==="refs")controller.abort();return result;
  });
  try {await expect(snapshot.remove("a",controller.signal)).rejects.toThrow();}finally{spy.mockRestore();}
  expect(await snapshot.page(0,25)).toEqual({ids:["b","a"],offset:0,total:2});
});

it("invalidates and physically clears snapshots when all encryption data is reset", async () => {
  await cacheDecryptedMessages([row("a",1)]);const snapshot=await create();
  await clearAllE2EEData();
  await expect(snapshot.page(0,25)).rejects.toThrow();
  await assertNoLeakedIndex();
});
it("cancels a snapshot that is still staging when encryption data is reset", async () => {
  await cacheDecryptedMessages(Array.from({length:300},(_,i)=>row(String(i).padStart(4,"0"),i)));
  let staged!:()=>void;const started=new Promise<void>(resolve=>{staged=resolve;});
  const original=IDBObjectStore.prototype.put;
  const spy=vi.spyOn(IDBObjectStore.prototype,"put").mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore["put"]>){
    const request=original.apply(this,args);if(this.name==="refs")staged();return request;
  });
  const pending=createCachedSearchSnapshot("dm","dm","ÉTÉ").then(snapshot=>{live.push(snapshot);return true;},()=>false);
  try {await started;await clearAllE2EEData();expect(await pending).toBe(false);}finally{spy.mockRestore();}
  await assertNoLeakedIndex();
});

it("rejects a snapshot after a reset committed by another tab", async () => {
  await cacheDecryptedMessages([row("a",1)]);const snapshot=await create();
  const source=await getDB(),tx=source.transaction(["messageCache","metadata"],"readwrite");
  await tx.objectStore("messageCache").clear();
  await tx.objectStore("metadata").put(crypto.randomUUID(),CACHED_SEARCH_EPOCH_KEY);await tx.done;
  await expect(snapshot.page(0,25)).rejects.toThrow("search_snapshot_cache_reset");
  await assertNoLeakedIndex();
});
it("does not make the source reset fence portable or revive it on a later reset", async () => {
  await clearAllE2EEData();const first=await getCachedSearchEpoch();
  expect(first).not.toBe("initial");expect((await getAllMetadata()).some(([key])=>key===CACHED_SEARCH_EPOCH_KEY)).toBe(false);
  await clearAllE2EEData();expect(await getCachedSearchEpoch()).not.toBe(first);
});
it("keeps new query creation blocked until all concurrent local resets finish", async () => {
  const source=await getDB();
  let releaseFirst!:()=>void,releaseSecond!:()=>void,enteredFirst!:()=>void,enteredSecond!:()=>void;
  const firstReady=new Promise<void>(resolve=>{enteredFirst=resolve;}),secondReady=new Promise<void>(resolve=>{enteredSecond=resolve;});
  const first=withResetCachedSearchSnapshots(source.name,async()=>{enteredFirst();await new Promise<void>(resolve=>{releaseFirst=resolve;});});
  const second=withResetCachedSearchSnapshots(source.name,async()=>{enteredSecond();await new Promise<void>(resolve=>{releaseSecond=resolve;});});
  await Promise.all([firstReady,secondReady]);releaseFirst();await first;
  await expect(createCachedSearchSnapshot("dm","dm","ÉTÉ")).rejects.toThrow("search_snapshot_resetting");
  releaseSecond();await second;const snapshot=await create();expect((await snapshot.page(0,25)).total).toBe(0);
});
