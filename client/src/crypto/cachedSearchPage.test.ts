import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import * as storage from "./keyStorage";
import { createCachedSearchSnapshot, type CachedSearchSnapshot } from "./cachedSearchSnapshot";
import { readCachedSearchPage } from "./cachedSearchPage";
let generation=0;const live:CachedSearchSnapshot[]=[];
beforeEach(async()=>{await storage.closeDB();globalThis.indexedDB=new IDBFactory();publishAuthOwnerChange("page-owner");publishAuthGenerationChange(++generation);});
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(live.splice(0).map(snapshot=>snapshot.dispose()));await storage.closeDB();});
const row=(index:number)=>({messageId:String(index).padStart(2,"0"),channelId:"",dmChannelId:"dm",timestamp:index,sourceSequence:String(index+1),content:`match ${index}`});
const matches=(record:Awaited<ReturnType<typeof storage.getCachedDecryptedMessage>>)=>Boolean(record?.dmChannelId==="dm"&&record.content.includes("match"));
async function snapshot(count:number){await storage.cacheDecryptedMessages(Array.from({length:count},(_,i)=>row(i)));const index=await createCachedSearchSnapshot("dm","dm","match");live.push(index);return index;}
it("removes missing/edited hits and refills a bounded window from the real index",async()=>{
 const index=await snapshot(27);await storage.deleteCachedDMMessage("26","dm",()=>true);await storage.cacheDecryptedMessage({...row(25),content:"edited away"});
 const page=await readCachedSearchPage(index,0,25,matches,()=>true);
 expect(page?.total).toBe(25);expect(page?.messages.map(item=>item.messageId)).toEqual(Array.from({length:25},(_,i)=>row(24-i).messageId));
});
it("reconciles a live index deletion during cache hydration",async()=>{
 const index=await snapshot(27),original=storage.getCachedDecryptedMessage;
 vi.spyOn(storage,"getCachedDecryptedMessage").mockImplementationOnce(async id=>{const value=await original(id);await index.remove("26");return value;});
 const page=await readCachedSearchPage(index,0,25,matches,()=>true);
 expect(page?.total).toBe(26);expect(page?.messages[0].messageId).toBe("25");expect(page?.messages).toHaveLength(25);
});
it("abandons a stale hydration before removing any index entry",async()=>{
 const index=await snapshot(2);let current=true;
 vi.spyOn(storage,"getCachedDecryptedMessage").mockImplementationOnce(async()=>{current=false;return null;});
 expect(await readCachedSearchPage(index,0,25,matches,()=>current)).toBeNull();expect((await index.page(0,25)).total).toBe(2);
});
it("clamps an emptied last page and hydrates its previous window",async()=>{
 const index=await snapshot(26);await storage.deleteCachedDMMessage("00","dm",()=>true);
 const page=await readCachedSearchPage(index,25,25,matches,()=>true);
 expect(page?.offset).toBe(0);expect(page?.total).toBe(25);expect(page?.messages).toHaveLength(25);
});

it("rechecks deletion tombstones after the final asynchronous index read",async()=>{
 const index=await snapshot(27),original=index.page.bind(index),hidden=new Set<string>();let reads=0;
 vi.spyOn(index,"page").mockImplementation(async(...args)=>{const page=await original(...args);if(++reads===2)hidden.add("26");return page;});
 const page=await readCachedSearchPage(index,0,25,record=>matches(record)&&!hidden.has(record.messageId),()=>true);
 expect(page?.messages[0].messageId).toBe("25");expect(page?.total).toBe(26);expect(page?.messages).toHaveLength(25);
});
