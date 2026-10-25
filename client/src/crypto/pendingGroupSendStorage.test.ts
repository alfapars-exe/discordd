import "fake-indexeddb/auto";
import {IDBFactory as FakeIDBFactory} from "fake-indexeddb";
import {beforeEach,expect,it,vi} from "vitest";
import * as storage from "./keyStorage";
import {publishAuthGenerationChange,publishAuthOwnerChange} from "../api/authSessionEvents";
import {loadPendingGroupSends,savePendingGroupSend,removePendingGroupSend,markPendingGroupSendConfirmed,acknowledgePendingGroupFiles,acknowledgePendingGroupFileChain,type PendingGroupSendSnapshot,type PendingGroupSendEnvelope} from "./pendingGroupSendStorage";
let authGeneration=0;
beforeEach(async()=>{await storage.closeDB();globalThis.indexedDB=new FakeIDBFactory();publishAuthOwnerChange("account");publishAuthGenerationChange(++authGeneration);await storage.setMetadata("warm",true)});
function snapshot(id="request-00000001"):PendingGroupSendSnapshot{return {accountId:"account",deviceId:"device",groupId:"group",id,createdAt:Date.now(),content:"private unsent message",payload:{client_request_id:id,ciphertext:"remote ciphertext",sender_device_id:"device",e2ee_metadata:"{}",key_epoch:1},files:[new File(["original private bytes"],"private filename.txt",{type:"text/plain",lastModified:1234})],encryptedFiles:[new File([new Uint8Array([7,8,9])],"encrypted_0.bin",{type:"application/octet-stream",lastModified:4321})],fileKeys:[{key:btoa("k".repeat(32)),iv:btoa("i".repeat(12)),filename:"private filename.txt",mimeType:"text/plain",originalSize:22,digest:"a".repeat(64)}]}}
it("persists only sealed data and restores exact original/encrypted bytes after connection restart",async()=>{
 const original=snapshot();await savePendingGroupSend(original,()=>true);
 const rows=await storage.listPendingGroupSendRecords("account","device");expect(rows).toHaveLength(1);
 const serialized=JSON.stringify(rows);for(const secret of [original.content,"private filename.txt",original.fileKeys![0].key,"original private bytes","remote ciphertext"])expect(serialized).not.toContain(secret);
 const key=await storage.getPendingGroupSendKey("account","device");expect(key?.extractable).toBe(false);await expect(crypto.subtle.exportKey("raw",key!)).rejects.toThrow();
 await storage.closeDB();const result=await loadPendingGroupSends("account","device",()=>true);
 expect(result.failed).toEqual([]);expect(result.sends).toHaveLength(1);const restored=result.sends[0];expect(restored.payload).toEqual(original.payload);expect(restored.content).toBe(original.content);expect(restored.fileKeys).toEqual(original.fileKeys);
 expect(restored.files[0].name).toBe(original.files[0].name);expect(restored.files[0].lastModified).toBe(1234);expect(await restored.files[0].text()).toBe(await original.files[0].text());expect(new Uint8Array(await restored.encryptedFiles[0].arrayBuffer())).toEqual(new Uint8Array([7,8,9]));
 await removePendingGroupSend("account","device","group",original.id);expect((await loadPendingGroupSends("account","device",()=>true)).sends).toEqual([]);
});
it("isolates owner/device namespaces and authenticates record/part scope",async()=>{
 const original=snapshot();await savePendingGroupSend(original,()=>true);
 expect((await loadPendingGroupSends("different","device",()=>true)).sends).toEqual([]);expect((await loadPendingGroupSends("account","different",()=>true)).sends).toEqual([]);
 const rows=await storage.listPendingGroupSendRecords("account","device");const copied=rows[0].value as PendingGroupSendEnvelope;
 const key=storage.pendingGroupSendPrefix("account","device")+JSON.stringify(["other-group",original.id]);await storage.setMetadata(key,copied);
 let result=await loadPendingGroupSends("account","device",()=>true);expect(result.sends).toHaveLength(1);expect(result.failed).toEqual([{groupId:"other-group",id:original.id}]);
 const envelope=structuredClone(copied);[envelope.files[0],envelope.encryptedFiles[0]]=[envelope.encryptedFiles[0],envelope.files[0]];await storage.setMetadata(storage.pendingGroupSendPrefix("account","device")+JSON.stringify(["group",original.id]),envelope);
 result=await loadPendingGroupSends("account","device",()=>true);expect(result.sends).toEqual([]);expect(result.failed).toHaveLength(2);expect(await storage.listPendingGroupSendRecords("account","device")).toHaveLength(2);
});
it("shares one atomic non-exportable key across simultaneous writers",async()=>{
 const keys=await Promise.all(Array.from({length:6},()=>storage.getOrCreatePendingGroupSendKey("account","device",()=>true)));
 const iv=crypto.getRandomValues(new Uint8Array(12)),encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},keys[0],new TextEncoder().encode("same key"));
 for(const key of keys)expect(new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv},key,encrypted))).toBe("same key");
});
it("does not overwrite an existing request, and logout clears both key and sealed records",async()=>{
 const original=snapshot();await savePendingGroupSend(original,()=>true);await expect(savePendingGroupSend({...original,content:"different payload"},()=>true)).rejects.toThrow("pending_send_already_stored");
 expect((await loadPendingGroupSends("account","device",()=>true)).sends[0].content).toBe(original.content);
 await storage.clearAllE2EEData();expect(await storage.getPendingGroupSendKey("account","device")).toBeNull();expect((await loadPendingGroupSends("account","device",()=>true)).sends).toEqual([]);
});
it("fails closed without silently replacing a missing local key",async()=>{
 const original=snapshot();await savePendingGroupSend(original,()=>true);
 await storage.setMetadata(`group_pending_key:v1:${JSON.stringify(["account","device"])}`,null);
 await expect(loadPendingGroupSends("account","device",()=>true)).rejects.toThrow("pending_send_key_missing");
 await expect(savePendingGroupSend(snapshot("request-00000002"),()=>true)).rejects.toThrow("pending_send_key_missing");expect(await storage.listPendingGroupSendRecords("account","device")).toHaveLength(1);
});
it("does not write plaintext or sealed payload after context cancellation, and surfaces storage failure",async()=>{
 await expect(savePendingGroupSend(snapshot(),()=>false)).rejects.toThrow("pending_send_context_changed");expect(await storage.listPendingGroupSendRecords("account","device")).toEqual([]);
 const original=snapshot();let active=true;const read=original.files[0].arrayBuffer.bind(original.files[0]);original.files[0].arrayBuffer=async()=>{const bytes=await read();active=false;return bytes};await expect(savePendingGroupSend(original,()=>active)).rejects.toThrow("pending_send_context_changed");expect(await storage.listPendingGroupSendRecords("account","device")).toEqual([]);
 const write=vi.spyOn(storage,"putPendingGroupSendRecord").mockRejectedValueOnce(new DOMException("full","QuotaExceededError"));await expect(savePendingGroupSend(snapshot(),()=>true)).rejects.toThrow("full");write.mockRestore();expect(await storage.listPendingGroupSendRecords("account","device")).toEqual([]);
});
it("rejects malformed snapshots before creating a local key or record",async()=>{
 const wrong=snapshot();wrong.payload={...wrong.payload,sender_device_id:"different"};await expect(savePendingGroupSend(wrong,()=>true)).rejects.toThrow("pending_send_invalid_manifest");
 const badKeys=snapshot();badKeys.fileKeys![0].key=btoa("short");await expect(savePendingGroupSend(badKeys,()=>true)).rejects.toThrow("pending_send_invalid_file_keys");
 expect(await storage.getPendingGroupSendKey("account","device")).toBeNull();expect(await storage.listPendingGroupSendRecords("account","device")).toEqual([]);
});
it("records monotonic encrypted file acknowledgements without changing payload or sealed file bytes",async()=>{
 const original=snapshot();await savePendingGroupSend(original,()=>true);const before=(await storage.getPendingGroupSendRecord("account","device","group",original.id)) as PendingGroupSendEnvelope;
 expect(await acknowledgePendingGroupFiles("account","device","group",original.id,[0,0],()=>true)).toEqual([0]);
 const after=(await storage.getPendingGroupSendRecord("account","device","group",original.id)) as PendingGroupSendEnvelope;
 expect(after.writeToken).not.toBe(before.writeToken);expect(after.manifest.iv).not.toEqual(before.manifest.iv);expect(after.files).toEqual(before.files);expect(after.encryptedFiles).toEqual(before.encryptedFiles);
 const loaded=(await loadPendingGroupSends("account","device",()=>true)).sends[0];expect(loaded.acknowledgedIndices).toEqual([0]);expect(loaded.payload).toEqual(original.payload);expect(await loaded.files[0].text()).toBe(await original.files[0].text());
 await acknowledgePendingGroupFiles("account","device","group",original.id,[0],()=>true);expect(((await storage.getPendingGroupSendRecord("account","device","group",original.id)) as PendingGroupSendEnvelope).writeToken).toBe(after.writeToken);
 await expect(acknowledgePendingGroupFiles("account","device","group",original.id,[1],()=>true)).rejects.toThrow("pending_send_invalid_acknowledgements");
});
it("authenticates reviewed-file mappings and rejects ambiguous or invalid source positions",async()=>{
 const original=snapshot();original.fileSources=[{fileIndex:0,deviceId:"old-device",id:"source-000000001",sourceIndex:4}];await savePendingGroupSend(original,()=>true);
 expect((await loadPendingGroupSends("account","device",()=>true)).sends[0].fileSources).toEqual(original.fileSources);
 for(const fileSources of [[{...original.fileSources[0],fileIndex:1}],[{...original.fileSources[0],sourceIndex:10}],[{...original.fileSources[0],id:original.id}],[original.fileSources[0],original.fileSources[0]]])await expect(savePendingGroupSend({...snapshot(),fileSources},()=>true)).rejects.toThrow("pending_send_invalid_sources");
});
it("does not lose concurrent acknowledgement updates or resurrect a deleted record",async()=>{
 const original=snapshot();original.files.push(new File(["second"],"second.txt",{type:"text/plain",lastModified:1234}));original.encryptedFiles.push(new File(["opaque"],"encrypted_1.bin"));original.fileKeys!.push({...original.fileKeys![0],filename:"second.txt",originalSize:6});await savePendingGroupSend(original,()=>true);
 await Promise.all([acknowledgePendingGroupFiles("account","device","group",original.id,[0],()=>true),acknowledgePendingGroupFiles("account","device","group",original.id,[1],()=>true)]);
 expect((await loadPendingGroupSends("account","device",()=>true)).sends[0].acknowledgedIndices).toEqual([0,1]);
 const stored=(await storage.getPendingGroupSendRecord("account","device","group",original.id)) as PendingGroupSendEnvelope;
 expect(await storage.replacePendingGroupSendRecord("account","device","group",original.id,"stale-token",{...stored,writeToken:crypto.randomUUID()},()=>true)).toBe(false);
 await removePendingGroupSend("account","device","group",original.id);
 expect(await storage.replacePendingGroupSendRecord("account","device","group",original.id,stored.writeToken,{...stored,writeToken:crypto.randomUUID()},()=>true)).toBe(false);
 await expect(acknowledgePendingGroupFiles("account","device","group",original.id,[0],()=>true)).rejects.toThrow("pending_send_not_found");
});
it("retains the original record after stale context, quota failure or tampered manifest during acknowledgement",async()=>{
 const original=snapshot();await savePendingGroupSend(original,()=>true);const before=(await storage.getPendingGroupSendRecord("account","device","group",original.id)) as PendingGroupSendEnvelope;
 await expect(acknowledgePendingGroupFiles("account","device","group",original.id,[0],()=>false)).rejects.toThrow("pending_send_context_changed");
 const write=vi.spyOn(storage,"replacePendingGroupSendRecord").mockRejectedValueOnce(new DOMException("full","QuotaExceededError"));await expect(acknowledgePendingGroupFiles("account","device","group",original.id,[0],()=>true)).rejects.toThrow("full");write.mockRestore();
 expect(((await storage.getPendingGroupSendRecord("account","device","group",original.id)) as PendingGroupSendEnvelope).writeToken).toBe(before.writeToken);
 const corrupted=structuredClone(before);new Uint8Array(corrupted.manifest.ciphertext)[0]^=1;await storage.setMetadata(storage.pendingGroupSendPrefix("account","device")+JSON.stringify(["group",original.id]),corrupted);
 await expect(acknowledgePendingGroupFiles("account","device","group",original.id,[0],()=>true)).rejects.toThrow();expect(await storage.listPendingGroupSendRecords("account","device")).toHaveLength(1);
});
it("acknowledges every authenticated ancestor before the reviewed source, idempotently",async()=>{
 const root=snapshot("root-request-0001"),middle=snapshot("middle-request-01"),leaf=snapshot("leaf-request-0001");
 middle.fileSources=[{fileIndex:0,deviceId:root.deviceId,id:root.id,sourceIndex:0}];leaf.fileSources=[{fileIndex:0,deviceId:middle.deviceId,id:middle.id,sourceIndex:0}];
 for(const item of [root,middle,leaf])await savePendingGroupSend(item,()=>true);
 const updates=await acknowledgePendingGroupFileChain("account","device","group",leaf.id,[0],()=>true);
 expect(updates.map(item=>item.id)).toEqual([root.id,middle.id,leaf.id]);
 expect((await loadPendingGroupSends("account","device",()=>true)).sends.every(item=>item.acknowledgedIndices?.[0]===0)).toBe(true);
 expect(await acknowledgePendingGroupFileChain("account","device","group",leaf.id,[0],()=>true)).toEqual(updates);
});
it("preserves concurrent confirmation and file receipts across connection restart",async()=>{
 const original=snapshot();await savePendingGroupSend(original,()=>true);const before=await storage.getPendingGroupSendRecord("account","device","group",original.id) as PendingGroupSendEnvelope;
 await Promise.all([markPendingGroupSendConfirmed("account","device","group",original.id,()=>true),acknowledgePendingGroupFiles("account","device","group",original.id,[0],()=>true)]);
 await storage.closeDB();const loaded=(await loadPendingGroupSends("account","device",()=>true)).sends[0];expect(loaded.resultConfirmed).toBe(true);expect(loaded.acknowledgedIndices).toEqual([0]);expect(loaded.payload).toEqual(original.payload);
 const after=await storage.getPendingGroupSendRecord("account","device","group",original.id) as PendingGroupSendEnvelope;expect(after.files).toEqual(before.files);expect(after.encryptedFiles).toEqual(before.encryptedFiles);
 await markPendingGroupSendConfirmed("account","device","group",original.id,()=>true);expect((await storage.getPendingGroupSendRecord("account","device","group",original.id) as PendingGroupSendEnvelope).writeToken).toBe(after.writeToken);
 await removePendingGroupSend("account","device","group",original.id);await expect(markPendingGroupSendConfirmed("account","device","group",original.id,()=>true)).rejects.toThrow("pending_send_not_found");
});
it("does not write any receipts for cyclic or missing ancestry",async()=>{
 const a=snapshot("first-request-01"),b=snapshot("second-request-1");a.fileSources=[{fileIndex:0,deviceId:"device",id:b.id,sourceIndex:0}];b.fileSources=[{fileIndex:0,deviceId:"device",id:a.id,sourceIndex:0}];
 for(const item of [a,b])await savePendingGroupSend(item,()=>true);
 await expect(acknowledgePendingGroupFileChain("account","device","group",a.id,[0],()=>true)).rejects.toThrow("pending_send_source_cycle");
 expect((await loadPendingGroupSends("account","device",()=>true)).sends.every(item=>!item.acknowledgedIndices)).toBe(true);
 await removePendingGroupSend("account","device","group",b.id);
 await expect(acknowledgePendingGroupFileChain("account","device","group",a.id,[0],()=>true)).rejects.toThrow("pending_send_not_found");
 expect((await loadPendingGroupSends("account","device",()=>true)).sends[0].acknowledgedIndices).toBeUndefined();
});
it("retains an interrupted chain and safely finishes receipts on retry",async()=>{
 const root=snapshot("root-request-0001"),child=snapshot("child-request-01");child.fileSources=[{fileIndex:0,deviceId:"device",id:root.id,sourceIndex:0}];for(const item of [root,child])await savePendingGroupSend(item,()=>true);
 const replace=storage.replacePendingGroupSendRecord;let writes=0;
 const spy=vi.spyOn(storage,"replacePendingGroupSendRecord").mockImplementation(async(...args)=>{if(++writes===2)throw new DOMException("full","QuotaExceededError");return replace(...args)});
 await expect(acknowledgePendingGroupFileChain("account","device","group",child.id,[0],()=>true)).rejects.toThrow("full");spy.mockRestore();
 let records=(await loadPendingGroupSends("account","device",()=>true)).sends;expect(records.find(item=>item.id===root.id)?.acknowledgedIndices).toEqual([0]);expect(records.find(item=>item.id===child.id)?.acknowledgedIndices).toBeUndefined();
 await acknowledgePendingGroupFileChain("account","device","group",child.id,[0],()=>true);records=(await loadPendingGroupSends("account","device",()=>true)).sends;expect(records.every(item=>item.acknowledgedIndices?.[0]===0)).toBe(true);
});
