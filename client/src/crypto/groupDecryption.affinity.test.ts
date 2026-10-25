import { beforeEach,expect,it,vi } from "vitest";
import { decryptGroupDMMessages } from "./dmEncryption";
import * as keyStorage from "./keyStorage";
import * as signalProtocol from "./signalProtocol";
import type { GroupDMMessage } from "../types/groupDM";
import { groupMessageCacheTag } from "./groupMessageCache";
vi.mock("./keyStorage",()=>({getCachedDecryptedMessage:vi.fn(),cacheDecryptedMessage:vi.fn(),getTrustedIdentity:vi.fn(async()=>({})),getTrustedDeviceIdsForUser:vi.fn(async()=>new Set())}));
vi.mock("./signalProtocol",()=>({decryptMessage:vi.fn()}));
vi.mock("../stores/e2eeStore",()=>({useE2EEStore:{getState:()=>({localDeviceId:"local",markPeerTrustAlert:vi.fn()})}}));
vi.mock("../api/clientLog",()=>({logToServer:vi.fn()}));
const message={id:"m",group_id:"g",user_id:"other",content:null,sender_device_id:"remote",ciphertext:JSON.stringify([{recipient_device_id:"local",ciphertext:"{}"}]),attachments:[],created_at:"2026-10-24T00:00:00Z"} as unknown as GroupDMMessage;
beforeEach(()=>{vi.clearAllMocks();vi.mocked(keyStorage.getCachedDecryptedMessage).mockResolvedValue(null);vi.mocked(keyStorage.cacheDecryptedMessage).mockResolvedValue(undefined);vi.mocked(signalProtocol.decryptMessage).mockResolvedValue(JSON.stringify({content:"private"}));});
it("restores cached canonical source order only after exact group/ciphertext affinity, without replacing server order",async()=>{
  const cached={messageId:"m",content:"cached",channelId:"",dmChannelId:"group:g",timestamp:0,sourceSequence:"9007199254740993",encryptedSourceTag:await groupMessageCacheTag(message)};
  vi.mocked(keyStorage.getCachedDecryptedMessage).mockResolvedValue(cached);
  expect((await decryptGroupDMMessages([message]))[0].source_sequence).toBe(cached.sourceSequence);
  expect((await decryptGroupDMMessages([{...message,source_sequence:"9007199254740994"}]))[0].source_sequence).toBe("9007199254740994");
  vi.mocked(keyStorage.getCachedDecryptedMessage).mockResolvedValue({...cached,dmChannelId:"group:other"});
  expect((await decryptGroupDMMessages([message]))[0].source_sequence).toBeUndefined();
});
it("does not even read the cache for an invalidated operation",async()=>{
  expect(await decryptGroupDMMessages([message],()=>false)).toEqual([]);
  expect(keyStorage.getCachedDecryptedMessage).not.toHaveBeenCalled();
});
it("discards cached plaintext after the operation becomes stale",async()=>{
  let current=true;
  vi.mocked(keyStorage.getCachedDecryptedMessage).mockImplementationOnce(async()=>{current=false;return {messageId:"m",content:"private cache",channelId:"",dmChannelId:"group:g",timestamp:0}});
  expect(await decryptGroupDMMessages([message],()=>current)).toEqual([]);
  expect(signalProtocol.decryptMessage).not.toHaveBeenCalled();
});
it("does not cache or return plaintext after decryption invalidates the operation",async()=>{
  let current=true;
  vi.mocked(signalProtocol.decryptMessage).mockImplementationOnce(async()=>{current=false;return JSON.stringify({content:"private decrypted"})});
  expect(await decryptGroupDMMessages([message],()=>current)).toEqual([]);
  expect(keyStorage.cacheDecryptedMessage).not.toHaveBeenCalled();
});
it("passes a scope-aware operation guard to a successful cache write",async()=>{
  const current=()=>true;
  const result=await decryptGroupDMMessages([message],current);
  expect(result[0].content).toBe("private");
  expect(keyStorage.cacheDecryptedMessage).toHaveBeenCalledWith(expect.objectContaining({dmChannelId:"group:g",content:"private"}),expect.any(Function));
});
it("does not overwrite a newer message cache when one history item is superseded mid-decryption",async()=>{
  let firstCurrent=true;
  vi.mocked(signalProtocol.decryptMessage).mockImplementationOnce(async()=>{firstCurrent=false;return JSON.stringify({content:"old version"})});
  const second={...message,id:"second"};
  const result=await decryptGroupDMMessages([message,second],()=>true,item=>item.id!=="m"||firstCurrent);
  expect(result.map(item=>item.id)).toEqual(["second"]);
  expect(keyStorage.cacheDecryptedMessage).toHaveBeenCalledTimes(1);
  expect(keyStorage.cacheDecryptedMessage).toHaveBeenCalledWith(expect.objectContaining({messageId:"second"}),expect.any(Function));
});
it("reuses only the exact encrypted source version, even for own-device attachment messages",async()=>{
  const own={...message,sender_device_id:"local",attachments:[{id:"file"}] as GroupDMMessage["attachments"]};
  const fileKeys=[{key:"key",iv:"iv",filename:"photo.png",mimeType:"image/png",originalSize:5,digest:"digest"}];
  vi.mocked(keyStorage.getCachedDecryptedMessage).mockResolvedValueOnce({messageId:"m",content:"own message",channelId:"",dmChannelId:"group:g",timestamp:0,encryptedSourceTag:await groupMessageCacheTag(own),fileKeys});
  const result=await decryptGroupDMMessages([own]);
  expect(result[0]).toMatchObject({content:"own message",e2ee_file_keys:fileKeys});
  expect(signalProtocol.decryptMessage).not.toHaveBeenCalled();
});
it("reuses the correct sparse attachment key after an earlier upload failed",async()=>{
  const own={...message,sender_device_id:"local",attachments:[{id:"third",filename:"encrypted_2.bin",file_key_index:2}] as GroupDMMessage["attachments"]};
  const fileKeys=[0,1,2].map(i=>({key:`key-${i}`,iv:"iv",filename:`file-${i}`,mimeType:"image/png",originalSize:5,digest:"digest"}));
  vi.mocked(keyStorage.getCachedDecryptedMessage).mockResolvedValueOnce({messageId:"m",content:"own",channelId:"",dmChannelId:"group:g",timestamp:0,encryptedSourceTag:await groupMessageCacheTag(own),fileKeys});
  const result=await decryptGroupDMMessages([own]);
  expect(result[0].e2ee_file_keys?.[2]).toEqual(fileKeys[2]);expect(signalProtocol.decryptMessage).not.toHaveBeenCalled();
});
it("does not reuse an old body for a same-length edit sharing the same timestamp",async()=>{
  const first={...message,edited_at:"2026-10-24T01:00:00Z",ciphertext:JSON.stringify([{recipient_device_id:"local",ciphertext:JSON.stringify({type:1,ciphertext:"aaaa"})}])};
  const changed={...first,ciphertext:first.ciphertext.replace("aaaa","bbbb")};
  expect(changed.ciphertext.length).toBe(first.ciphertext.length);
  vi.mocked(keyStorage.getCachedDecryptedMessage).mockResolvedValueOnce({messageId:"m",content:"old body",channelId:"",dmChannelId:"group:g",timestamp:0,encryptedSourceTag:await groupMessageCacheTag(first)});
  vi.mocked(signalProtocol.decryptMessage).mockResolvedValueOnce(JSON.stringify({content:"new body"}));
  const result=await decryptGroupDMMessages([changed]);
  expect(result[0].content).toBe("new body");
  expect(signalProtocol.decryptMessage).toHaveBeenCalledOnce();
  expect(keyStorage.cacheDecryptedMessage).toHaveBeenCalledWith(expect.objectContaining({content:"new body",encryptedSourceTag:await groupMessageCacheTag(changed)}),expect.any(Function));
});
it("does not accept a matching message-id cache entry from another conversation",async()=>{
  vi.mocked(keyStorage.getCachedDecryptedMessage).mockResolvedValueOnce({messageId:"m",content:"other scope",channelId:"",dmChannelId:"group:other",timestamp:0,encryptedSourceTag:await groupMessageCacheTag(message)});
  const result=await decryptGroupDMMessages([message]);
  expect(result[0].content).toBe("private");expect(signalProtocol.decryptMessage).toHaveBeenCalledOnce();
});
it("upgrades an unedited legacy original without replaying its consumed Signal message",async()=>{
  vi.mocked(keyStorage.getCachedDecryptedMessage).mockResolvedValueOnce({messageId:"m",content:"original cached",channelId:"",dmChannelId:"group:g",timestamp:0});
  const result=await decryptGroupDMMessages([message]);
  expect(result[0].content).toBe("original cached");expect(signalProtocol.decryptMessage).not.toHaveBeenCalled();
  expect(keyStorage.cacheDecryptedMessage).toHaveBeenCalledWith(expect.objectContaining({content:"original cached",encryptedSourceTag:await groupMessageCacheTag(message)}),expect.any(Function));
});
it("preserves but does not expose an unverified legacy edit when the current version cannot decrypt",async()=>{
  vi.mocked(keyStorage.getCachedDecryptedMessage).mockResolvedValueOnce({messageId:"m",content:"old private body",channelId:"",dmChannelId:"group:g",timestamp:0});
  vi.mocked(signalProtocol.decryptMessage).mockRejectedValueOnce(new Error("current version unavailable"));
  const result=await decryptGroupDMMessages([{...message,edited_at:"2026-10-24T01:00:00Z"}]);
  expect(result[0]).toMatchObject({content:null,decryption_error:"version_unavailable"});
  expect(keyStorage.cacheDecryptedMessage).not.toHaveBeenCalled();
});
it("keeps successfully decrypted attachment-only content when the local cache write fails",async()=>{
  vi.mocked(keyStorage.cacheDecryptedMessage).mockRejectedValueOnce(new Error("disk full"));
  const file_keys=[{key:"key",iv:"iv",filename:"photo.png",mimeType:"image/png",originalSize:5,digest:"digest"}];
  vi.mocked(signalProtocol.decryptMessage).mockResolvedValueOnce(JSON.stringify({content:"",file_keys}));
  const result=await decryptGroupDMMessages([message]);
  expect(result).toHaveLength(1);expect(result[0]).toMatchObject({content:"",e2ee_file_keys:file_keys});
});
