import {beforeEach,expect,it,vi} from "vitest";
import type {DMMessage} from "../types/dm";
import type {CachedDecryptedMessage} from "./types";
const records=vi.hoisted(()=>new Map<string,CachedDecryptedMessage>());
vi.mock("./keyStorage",()=>({cacheDecryptedMessage:vi.fn(async(record:CachedDecryptedMessage,current:()=>boolean)=>{if(current())records.set(record.messageId,record)}),getCachedDecryptedMessage:vi.fn(async(id:string)=>records.get(id)??null)}));
import {cacheDMMessage,readDMMessageCache,dmMessageCacheTag} from "./dmMessageCache";
import * as storage from "./keyStorage";
import {captureDMReceipt,observeDMMessage} from "./dmMessageVersions";
import {useComposerDraftStore} from "../stores/composerDraftStore";
const message={id:"m",dm_channel_id:"dm",user_id:"u",sender_device_id:"device",ciphertext:"abcd",e2ee_metadata:"{}",encryption_version:1,content:null,edited_at:null,created_at:"2026-10-24T00:00:00Z",attachments:[]} as unknown as DMMessage;
beforeEach(()=>{records.clear();vi.clearAllMocks();useComposerDraftStore.getState().reset()});
it("does not let an older receipt finish hashing and overwrite the newer live source",async()=>{
  const claim=captureDMReceipt("dm"),oldGuard=claim(message);
  expect(oldGuard).not.toBeNull();
  const oldWrite=cacheDMMessage(message,{content:"old"},()=>oldGuard?.()??false);
  const updated={...message,ciphertext:"newer"};
  const live=observeDMMessage("dm","m",false,updated);
  await cacheDMMessage(updated,{content:"new"},live);
  await oldWrite;
  expect(await readDMMessageCache(updated,()=>true)).toMatchObject({content:"new"});
  expect(records.get("m")?.content).toBe("new");
});
it("does not create a cache record after a deletion invalidates its receipt",async()=>{
  const guard=captureDMReceipt("dm")(message);
  const write=cacheDMMessage(message,{content:"deleted"},()=>guard?.()??false);
  observeDMMessage("dm","m",true);
  await write;
  expect(records.size).toBe(0);
});
it("uses real SHA-256 and distinguishes same-length ciphertext versions",async()=>{
 const tag=await dmMessageCacheTag(message);expect(tag).toMatch(/^dm-v1:[a-f0-9]{64}$/);expect(await dmMessageCacheTag({...message,ciphertext:"abce"})).not.toBe(tag);expect(await dmMessageCacheTag({...message,edited_at:"timestamp"})).toBe(tag);
});
it.each([{dm_channel_id:"other"},{user_id:"other"},{sender_device_id:"other"},{e2ee_metadata:'{"send":"other"}'}])("does not reuse a cached payload for changed source %j",async(change)=>{
 await cacheDMMessage(message,{content:"old"},()=>true);expect(await readDMMessageCache({...message,...change},()=>true)).toBeNull();expect(records.size).toBe(1);
});
it("restores attachment-only content and retained original file-key positions",async()=>{
 const keys=["zero","one","two"].map(key=>({key,iv:"iv",digest:"digest",filename:"file.txt",mimeType:"text/plain",originalSize:1}));
 const source={...message,attachments:[{id:"a",dm_message_id:"m",filename:"encrypted_2.bin",file_url:"/file",file_size:1,mime_type:"application/octet-stream"}]};
 await cacheDMMessage(source,{content:"",file_keys:keys},()=>true);expect(await readDMMessageCache(source,()=>true)).toEqual({content:"",file_keys:keys});records.get("m")!.fileKeys=keys.slice(0,2);expect(await readDMMessageCache(source,()=>true)).toBeNull();
});
it("preserves legacy unedited text but does not apply it to an edited or attachment version",async()=>{
 records.set("m",{messageId:"m",channelId:"",dmChannelId:"dm",content:"legacy",timestamp:0});expect(await readDMMessageCache(message,()=>true)).toMatchObject({content:"legacy"});expect(await readDMMessageCache({...message,edited_at:"edited"},()=>true)).toBeNull();expect(await readDMMessageCache({...message,attachments:[{filename:"encrypted_0.bin"}] as DMMessage["attachments"]},()=>true)).toBeNull();
});
it("rejects cross-scope records and stale lookup/write contexts without deleting data",async()=>{
 await cacheDMMessage(message,{content:"current"},()=>true);const retained=records.get("m")!;records.set("m",{...retained,dmChannelId:"group:dm"});expect(await readDMMessageCache(message,()=>true)).toBeNull();records.set("m",retained);
 let active=true,finish!:(record:CachedDecryptedMessage)=>void;vi.mocked(storage.getCachedDecryptedMessage).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));const lookup=readDMMessageCache(message,()=>active);active=false;finish(retained);expect(await lookup).toBeNull();await cacheDMMessage(message,{content:"stale"},()=>false);expect(records.get("m")?.content).toBe("current");
});
