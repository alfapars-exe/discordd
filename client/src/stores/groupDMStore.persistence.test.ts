import "fake-indexeddb/auto";
import {IDBFactory as FakeIDBFactory} from "fake-indexeddb";
import {beforeEach,expect,it,vi} from "vitest";
vi.mock("../api/groupDM",()=>({sendGroupDMMessage:vi.fn(),getGroupSendOutcome:vi.fn()}));
vi.mock("../crypto/dmEncryption",()=>({encryptGroupDMMessage:vi.fn(async()=>[]),decryptGroupDMMessages:vi.fn(async messages=>messages)}));
import * as api from "../api/groupDM";
import * as storage from "../crypto/keyStorage";
import {loadPendingGroupSends,savePendingGroupSend,acknowledgePendingGroupFiles} from "../crypto/pendingGroupSendStorage";
import {useComposerDraftStore,composerKey} from "./composerDraftStore";
import {loadGroupSendRestorePlan} from "./shared/groupSendRestoreQueue";
import {useGroupDMStore} from "./groupDMStore";
import {useAuthStore} from "./authStore";
import {useE2EEStore} from "./e2eeStore";
import type {GroupDM,GroupDMMessage} from "../types/groupDM";

beforeEach(async()=>{
 await storage.closeDB();globalThis.indexedDB=new FakeIDBFactory();vi.clearAllMocks();
 useAuthStore.setState({user:{id:"persist-owner"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>});useE2EEStore.setState({localDeviceId:"persist-device",initStatus:"ready"});useComposerDraftStore.getState().reset();
 const group:GroupDM={id:"persist-group",owner_id:"persist-owner",name:"Persistent",members:[],icon_url:null,key_epoch:1,call_room_key:"room",unread_count:0,created_at:"2026-10-24T00:00:00Z",updated_at:"2026-10-24T00:00:00Z"};
 useGroupDMStore.setState({groups:[group],pendingSends:{},uploadRecoveries:{},messages:{},error:null,groupsReady:true,restoreStatus:"ready",restoreDeviceId:"persist-device",restoreScope:null,restoreBlocked:[],restoredQueue:{}});
});
it("hydrates encrypted pending work without replay and resolves a child before its queued source",async()=>{
 vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});await useGroupDMStore.getState().send("persist-group","source");
 const original=(await loadPendingGroupSends("persist-owner","persist-device",()=>true)).sends[0],childId=crypto.randomUUID();
 await savePendingGroupSend({...original,id:childId,createdAt:original.createdAt-1000,content:"child",payload:{...original.payload,client_request_id:childId},origin:{deviceId:"persist-device",id:original.id}},()=>true);
 await storage.closeDB();useGroupDMStore.setState({pendingSends:{},restoredQueue:{},restoreStatus:"idle",restoreScope:null});
 await useGroupDMStore.getState().restorePendingSends();
 expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(useGroupDMStore.getState().pendingSends["persist-group"]).toMatchObject({id:childId,stored:true,restored:true,busy:false});expect(useGroupDMStore.getState().restoredQueue["persist-group"].map(item=>item.id)).toEqual([original.id]);
 expect(useComposerDraftStore.getState().drafts[composerKey("persist-owner","group","persist-group")].content).toBe("child");
 vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:true,data:{operation:{request_id:childId,group_id:"persist-group",message_id:"child-message",file_count:0,failed_indices:[],phase:"completed",created_at:"2026-10-24T00:00:00Z",updated_at:"2026-10-24T00:00:00Z"},message:{id:"child-message",group_id:"persist-group",user_id:"persist-owner",ciphertext:original.payload.ciphertext,created_at:"2026-10-24T00:00:00Z",attachments:[]} as unknown as GroupDMMessage}});
 expect(await useGroupDMStore.getState().retryPendingSend("persist-group")).toBe(true);
 expect(useGroupDMStore.getState().pendingSends["persist-group"]).toBeUndefined();expect(useGroupDMStore.getState().restoredQueue["persist-group"]).toEqual([]);expect(await storage.listPendingGroupSendRecords("persist-owner","persist-device")).toEqual([]);expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();
});

it("has a decryptable durable exact-byte copy before POST and retains it on a network timeout",async()=>{
 const file=new File(["private attachment"],"private.txt",{type:"text/plain"});
 let originalRequest:api.GroupSendPayload|undefined,wireBytes:ArrayBuffer|undefined;
 vi.mocked(api.sendGroupDMMessage).mockImplementationOnce(async(_group,payload,files)=>{
  originalRequest=payload;wireBytes=await files![0].arrayBuffer();
  const local=await loadPendingGroupSends("persist-owner","persist-device",()=>true);expect(local.failed).toEqual([]);expect(local.sends).toHaveLength(1);expect(local.sends[0].payload).toEqual(payload);
  expect(new Uint8Array(await local.sends[0].encryptedFiles[0].arrayBuffer())).toEqual(new Uint8Array(wireBytes));
  return {success:false,isTimeout:true};
 });
 expect(await useGroupDMStore.getState().send("persist-group","private unsent text",undefined,[file])).toBe(false);
 await storage.closeDB();const local=await loadPendingGroupSends("persist-owner","persist-device",()=>true);expect(local.sends[0].payload).toEqual(originalRequest);expect(await local.sends[0].files[0].text()).toBe("private attachment");
 const meta=local.sends[0].fileKeys![0],decode=(value:string)=>Uint8Array.from(atob(value),char=>char.charCodeAt(0));
 const key=await crypto.subtle.importKey("raw",decode(meta.key),{name:"AES-GCM"},false,["decrypt"]);
 expect(new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:decode(meta.iv)},key,wireBytes!))).toBe("private attachment");
 expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(useGroupDMStore.getState().pendingSends["persist-group"]?.stored).toBe(true);
 useGroupDMStore.setState({pendingSends:{},restoredQueue:{},restoreStatus:"idle",restoreScope:null});useComposerDraftStore.getState().reset();await useGroupDMStore.getState().restorePendingSends();
 expect(useGroupDMStore.getState().pendingSends["persist-group"]?.files?.[0].name).toBe("private.txt");expect(useComposerDraftStore.getState().drafts[composerKey("persist-owner","group","persist-group")]).toMatchObject({content:"private unsent text",files:[]});expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();
});

it("removes the real encrypted recovery record only after a committed full success",async()=>{
 vi.mocked(api.sendGroupDMMessage).mockImplementationOnce(async(group,payload)=>{
  expect(await storage.listPendingGroupSendRecords("persist-owner","persist-device")).toHaveLength(1);
  const message:GroupDMMessage={id:"committed",group_id:group,user_id:"persist-owner",content:null,encryption_version:1,ciphertext:payload.ciphertext,sender_device_id:payload.sender_device_id,e2ee_metadata:payload.e2ee_metadata,key_epoch:1,reply_to_id:payload.reply_to_id??null,edited_at:null,created_at:"2026-10-24T00:00:00Z",attachments:[],reactions:[]};
  return {success:true,status:201,data:message};
 });
 expect(await useGroupDMStore.getState().send("persist-group","text")).toBe(true);
 expect(await storage.listPendingGroupSendRecords("persist-owner","persist-device")).toEqual([]);expect(useGroupDMStore.getState().pendingSends["persist-group"]).toBeUndefined();
});
it("restores a confirmed cleanup failure as lookup-only and never replays a missing result",async()=>{
 let sentPayload:api.GroupSendPayload|undefined;
 const message=(payload:api.GroupSendPayload):GroupDMMessage=>({id:"confirmed",group_id:"persist-group",user_id:"persist-owner",content:null,encryption_version:1,ciphertext:payload.ciphertext,sender_device_id:payload.sender_device_id,e2ee_metadata:payload.e2ee_metadata,key_epoch:1,reply_to_id:null,edited_at:null,created_at:"2026-10-24T00:00:00Z",attachments:[],reactions:[]});
 vi.mocked(api.sendGroupDMMessage).mockImplementationOnce(async(_group,payload)=>{sentPayload=payload;return {success:true,status:201,data:message(payload)}});
 const cleanup=vi.spyOn(storage,"deletePendingGroupSendRecord").mockRejectedValueOnce(new DOMException("busy","UnknownError"));
 expect(await useGroupDMStore.getState().send("persist-group","confirmed")).toBe(true);cleanup.mockRestore();
 const saved=(await loadPendingGroupSends("persist-owner","persist-device",()=>true)).sends[0];expect(saved.resultConfirmed).toBe(true);
 await storage.closeDB();useGroupDMStore.setState({pendingSends:{},restoredQueue:{},restoreStatus:"idle",restoreScope:null});useComposerDraftStore.getState().reset();await useGroupDMStore.getState().restorePendingSends();
 expect(useGroupDMStore.getState().pendingSends["persist-group"]).toMatchObject({resultConfirmed:true,lookupOnly:true,stored:true});
 vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:false,status:404});expect(await useGroupDMStore.getState().retryPendingSend("persist-group")).toBe(false);expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(useGroupDMStore.getState().error).toBe("groupSendCommittedLookupPending");
 vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:true,data:{operation:{request_id:saved.id,group_id:"persist-group",message_id:"confirmed",file_count:0,failed_indices:[],phase:"completed",created_at:"2026-10-24T00:00:00Z",updated_at:"2026-10-24T00:00:00Z"},message:message(sentPayload!)}});
 expect(await useGroupDMStore.getState().retryPendingSend("persist-group")).toBe(true);expect(await storage.listPendingGroupSendRecords("persist-owner","persist-device")).toEqual([]);expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();
});
it("loads a scoped restart plan without network replay or draft mutation",async()=>{
 vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});await useGroupDMStore.getState().send("persist-group","pending");
 const id=useGroupDMStore.getState().pendingSends["persist-group"]!.id;await storage.closeDB();
 const plan=await loadGroupSendRestorePlan("persist-owner","persist-device",new Set(["persist-group"]),()=>true);
 expect(plan.blocked).toEqual([]);expect(plan.groups["persist-group"].map(item=>item.id)).toEqual([id]);expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();
 const unavailable=await loadGroupSendRestorePlan("persist-owner","persist-device",new Set(),()=>true);expect(Object.keys(unavailable.groups)).toEqual([]);expect(unavailable.unavailable).toEqual([{groupId:"persist-group",id}]);
 await expect(loadGroupSendRestorePlan("persist-owner","persist-device",new Set(["persist-group"]),()=>false)).rejects.toThrow("pending_send_context_changed");
 expect(await storage.listPendingGroupSendRecords("persist-owner","persist-device")).toHaveLength(1);
});
it("does not offer an acknowledged source file as a fresh retry after restoration",async()=>{
 const file=new File(["private"],"source.txt",{type:"text/plain"});vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});await useGroupDMStore.getState().send("persist-group","source",undefined,[file]);
 const source=(await loadPendingGroupSends("persist-owner","persist-device",()=>true)).sends[0];
 // Simulates the trusted receipt producer after a different send's confirmed
 // success. Manual-review production of this receipt is a separate integration.
 await acknowledgePendingGroupFiles("persist-owner","persist-device","persist-group",source.id,[0],()=>true);
 useGroupDMStore.setState({pendingSends:{},restoredQueue:{},restoreStatus:"idle",restoreScope:null});useComposerDraftStore.getState().reset();await useGroupDMStore.getState().restorePendingSends();
 vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:true,data:{operation:{group_id:"persist-group",request_id:source.id,message_id:"original-message",file_count:1,phase:"completed",failed_indices:[0],created_at:"2026-10-24T00:00:00Z",updated_at:"2026-10-24T00:00:00Z"},message:{id:"original-message",group_id:"persist-group",user_id:"persist-owner",ciphertext:source.payload.ciphertext,attachments:[],created_at:"2026-10-24T00:00:00Z"} as unknown as GroupDMMessage}});
 expect(await useGroupDMStore.getState().retryPendingSend("persist-group")).toBe(true);expect(useGroupDMStore.getState().uploadRecoveries["persist-group"]??[]).toEqual([]);expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(await storage.listPendingGroupSendRecords("persist-owner","persist-device")).toEqual([]);
});
it("persists reviewed-file provenance before POST and acknowledges only confirmed attachments",async()=>{
 const file=new File(["reviewed"],"review.txt",{type:"text/plain"});
 const message=(payload:api.GroupSendPayload,id:string,attachments:GroupDMMessage["attachments"]=[])=>({id,group_id:"persist-group",user_id:"persist-owner",ciphertext:payload.ciphertext,attachments,created_at:"2026-10-24T00:00:00Z"} as GroupDMMessage);
 vi.mocked(api.sendGroupDMMessage).mockImplementationOnce(async(_group,payload)=>({success:true,status:207,data:{message:message(payload,"source-message"),upload_failures:[{filename:"encrypted_0.bin",file_key_index:0,error:"upload_failed"}]}}));
 expect(await useGroupDMStore.getState().send("persist-group","source",undefined,[file])).toBe(true);
 const recovery=useGroupDMStore.getState().uploadRecoveries["persist-group"][0],sourceId=recovery.durable!.id;
 expect(useGroupDMStore.getState().restoreUploadRecovery("persist-group",recovery.id)).toBe(true);
 vi.mocked(api.sendGroupDMMessage).mockImplementationOnce(async(_group,payload)=>{
  const saved=(await loadPendingGroupSends("persist-owner","persist-device",()=>true)).sends.find(item=>item.id===payload.client_request_id)!;
  expect(saved.fileSources).toEqual([{fileIndex:0,deviceId:"persist-device",id:sourceId,sourceIndex:0}]);
  return {success:true,status:201,data:message(payload,"reviewed-message",[{filename:"encrypted_0.bin",file_key_index:0} as GroupDMMessage["attachments"][number]])};
 });
 expect(await useGroupDMStore.getState().send("persist-group","reviewed",undefined,[file])).toBe(true);
 const remaining=(await loadPendingGroupSends("persist-owner","persist-device",()=>true)).sends;
 expect(remaining).toHaveLength(1);expect(remaining[0].id).toBe(sourceId);expect(remaining[0].acknowledgedIndices).toEqual([0]);expect(api.sendGroupDMMessage).toHaveBeenCalledTimes(2);
});
it("propagates a successful retry through repeated partial reviewed sends without deleting ancestry early",async()=>{
 const file=new File(["chain"],"chain.txt",{type:"text/plain"});
 const response=(payload:api.GroupSendPayload,id:string,partial:boolean)=>{
  const message={id,group_id:"persist-group",user_id:"persist-owner",ciphertext:payload.ciphertext,attachments:partial?[]:[{filename:"encrypted_0.bin",file_key_index:0}],created_at:"2026-10-24T00:00:00Z"} as GroupDMMessage;
  return partial?{success:true,status:207,data:{message,upload_failures:[{filename:"encrypted_0.bin",file_key_index:0,error:"failed"}]}}:{success:true,status:201,data:message};
 };
 vi.mocked(api.sendGroupDMMessage).mockImplementationOnce(async(_group,payload)=>response(payload,"first",true));
 expect(await useGroupDMStore.getState().send("persist-group","first",undefined,[file])).toBe(true);
 const first=useGroupDMStore.getState().uploadRecoveries["persist-group"][0];useGroupDMStore.getState().restoreUploadRecovery("persist-group",first.id);
 vi.mocked(api.sendGroupDMMessage).mockImplementationOnce(async(_group,payload)=>response(payload,"second",true));
 expect(await useGroupDMStore.getState().send("persist-group","second",undefined,[file])).toBe(true);
 const second=useGroupDMStore.getState().uploadRecoveries["persist-group"][0];
 expect((await loadPendingGroupSends("persist-owner","persist-device",()=>true)).sends).toHaveLength(2);
 vi.mocked(api.sendGroupDMMessage).mockImplementationOnce(async(_group,payload)=>response(payload,"third",false));
 expect(await useGroupDMStore.getState().retryUploadRecovery("persist-group",second.id)).toBe(true);
 const records=(await loadPendingGroupSends("persist-owner","persist-device",()=>true)).sends;
 expect(records.map(item=>item.id).sort()).toEqual([first.durable!.id,second.durable!.id].sort());expect(records.every(item=>item.acknowledgedIndices?.[0]===0)).toBe(true);expect(api.sendGroupDMMessage).toHaveBeenCalledTimes(3);
});
