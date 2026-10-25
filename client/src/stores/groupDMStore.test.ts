import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupDM, GroupDMMessage } from "../types/groupDM";
import type { GroupSendOutcome } from "../types/groupDM";

vi.mock("../api/groupDM", () => ({
  listGroupDMs: vi.fn(), createGroupDM: vi.fn(), listGroupDMMessages: vi.fn(),getGroupDMMessagesAround:vi.fn(),
  sendGroupDMMessage: vi.fn(), leaveGroupDM: vi.fn(), addGroupDMMember: vi.fn(),
  getGroupSendOutcome:vi.fn(),reconcileGroupSend:vi.fn(),cancelGroupSend:vi.fn(),
  removeGroupDMMember: vi.fn(),
  editGroupDMMessage: vi.fn(), deleteGroupDMMessage: vi.fn(), toggleGroupDMReaction: vi.fn(), markGroupDMRead: vi.fn(), markGroupDMUnread: vi.fn(),
}));
vi.mock("../crypto/dmEncryption", () => ({
  decryptGroupDMMessages: vi.fn(async (messages: GroupDMMessage[]) => messages),
  encryptGroupDMMessage: vi.fn(),
}));
vi.mock("../crypto/keyStorage", () => ({ cacheDecryptedMessage: vi.fn() }));
vi.mock("../crypto/pendingGroupSendStorage",()=>({savePendingGroupSend:vi.fn(async()=>{}),removePendingGroupSend:vi.fn(async()=>{}),markPendingGroupSendConfirmed:vi.fn(async()=>{}),acknowledgePendingGroupFileChain:vi.fn(async()=>[])}));
vi.mock("./shared/groupSendRestoreQueue",()=>({loadGroupSendRestorePlan:vi.fn(async()=>({groups:{},blocked:[],unavailable:[]}))}));
vi.mock("./shared/messageUtils",async(original)=>({...await original<typeof import("./shared/messageUtils")>(),encryptFilesForE2EE:vi.fn()}));

import * as api from "../api/groupDM";
import { getAuthGeneration,setTokens } from "../api/client";
import { publishAuthOwnerChange } from "../api/authSessionEvents";
import { useGroupDMStore } from "./groupDMStore";
import { useAuthStore } from "./authStore";
import { useE2EEStore } from "./e2eeStore";
import { decryptGroupDMMessages,encryptGroupDMMessage } from "../crypto/dmEncryption";
import { cacheDecryptedMessage } from "../crypto/keyStorage";
import {savePendingGroupSend,removePendingGroupSend,markPendingGroupSendConfirmed,acknowledgePendingGroupFileChain} from "../crypto/pendingGroupSendStorage";
import {loadGroupSendRestorePlan} from "./shared/groupSendRestoreQueue";
import { encryptFilesForE2EE } from "./shared/messageUtils";
import { composerKey,useComposerDraftStore } from "./composerDraftStore";

const group = (id: string, epoch = 1): GroupDM => ({
  id, owner_id: "me", name: `Group ${id}`, icon_url: null, key_epoch: epoch,
  call_room_key: `room-${id}`, created_at: "2026-10-23T00:00:00Z",
  updated_at: "2026-10-23T00:00:00Z", members: [],
  unread_count: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(decryptGroupDMMessages).mockImplementation(async messages=>messages);
  vi.mocked(encryptGroupDMMessage).mockResolvedValue([]);
  vi.mocked(cacheDecryptedMessage).mockResolvedValue(undefined);
  vi.mocked(savePendingGroupSend).mockReset().mockResolvedValue(undefined);vi.mocked(removePendingGroupSend).mockReset().mockResolvedValue(undefined);
  vi.mocked(acknowledgePendingGroupFileChain).mockReset().mockResolvedValue([]);
  vi.mocked(markPendingGroupSendConfirmed).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.sendGroupDMMessage).mockReset();
  vi.mocked(api.getGroupSendOutcome).mockReset();vi.mocked(api.reconcileGroupSend).mockReset();vi.mocked(api.cancelGroupSend).mockReset();
  vi.mocked(encryptFilesForE2EE).mockImplementation(async files=>({files:files.map((_,i)=>new File(["encrypted"],`encrypted_${i}.bin`)),metas:files.map(file=>({key:"key",iv:"iv",filename:file.name,mimeType:file.type,originalSize:file.size,digest:"digest"}))}));
  vi.mocked(loadGroupSendRestorePlan).mockReset().mockResolvedValue({groups:{},blocked:[],unavailable:[]});
  useComposerDraftStore.getState().reset();
  useAuthStore.setState({user:{id:"me"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>});
  publishAuthOwnerChange("me");
  // Auth-owner changes synchronously clear account-scoped E2EE state.
  useE2EEStore.setState({localDeviceId:"device",initStatus:"ready"});
  useGroupDMStore.setState({ ownerId:"me",authGeneration:getAuthGeneration(),groups: [], messages: {},hasMoreAfterByGroup:{},scrollTarget:null, loading: false, error: null,uploadRecoveries:{},pendingSends:{},groupsReady:true,restoreStatus:"ready",restoreDeviceId:"device",restoreScope:null,restoreBlocked:[],restoredQueue:{} });
});

function outcome(id:string,phase:GroupSendOutcome["operation"]["phase"],message?:GroupDMMessage):GroupSendOutcome{return {operation:{request_id:id,group_id:"g1",message_id:message?.id??"saved",file_count:0,phase,failed_indices:[],created_at:"2026-10-24T00:00:00Z",updated_at:"2026-10-24T00:00:00Z"},message}}
const publicMember=(id:string)=>({id,username:id,display_name:id,avatar_url:null,status:"online" as const,custom_status:null,created_at:"2026-10-24T00:00:00Z"});
const groupMessage=(id:string,createdAt:string,userId="other"):GroupDMMessage=>({id,group_id:"g1",user_id:userId,content:`body-${id}`,encryption_version:1,ciphertext:`cipher-${id}`,sender_device_id:"device",e2ee_metadata:null,key_epoch:1,reply_to_id:null,edited_at:null,created_at:createdAt,reactions:[],attachments:[]});

it("fetches a scoped group around window, preserves order, exposes scroll target, and does not mark read",async()=>{
  useGroupDMStore.setState({groups:[group("g1")],messages:{g1:[groupMessage("old","2026-01-01T00:00:00Z")]}});
  vi.mocked(api.getGroupDMMessagesAround).mockResolvedValueOnce({success:true,data:{messages:[groupMessage("m2","2026-01-02T00:00:00Z"),groupMessage("m3","2026-01-03T00:00:00Z")],has_more:true,has_more_after:true}});
  expect(await useGroupDMStore.getState().fetchMessagesAround("g1","m2")).toBe(true);
  expect(api.getGroupDMMessagesAround).toHaveBeenCalledWith("g1","m2",50,expect.objectContaining({signal:expect.any(AbortSignal),timeoutMs:15_000,isCurrent:expect.any(Function)}));
  expect(useGroupDMStore.getState().messages.g1.map(message=>message.id)).toEqual(["m2","m3"]);
  expect(useGroupDMStore.getState().hasMoreAfterByGroup.g1).toBe(true);
  const request=useGroupDMStore.getState().setScrollTarget("g1","m2");
  expect(request).toEqual(expect.any(Number));expect(useGroupDMStore.getState().scrollTarget).toMatchObject({groupId:"g1",messageId:"m2",request});
  expect(api.markGroupDMRead).not.toHaveBeenCalled();
});

it("rejects a late around response after same-account reauthentication without changing messages",async()=>{
  const before=[groupMessage("keep","2026-01-01T00:00:00Z")];useGroupDMStore.setState({groups:[group("g1")],messages:{g1:before}});
  let finish!:(value:Awaited<ReturnType<typeof api.getGroupDMMessagesAround>>)=>void;
  vi.mocked(api.getGroupDMMessagesAround).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
  const request=useGroupDMStore.getState().fetchMessagesAround("g1","late");
  await vi.waitFor(()=>expect(api.getGroupDMMessagesAround).toHaveBeenCalledOnce());
  setTokens("refreshed-access-token","","me");
  finish({success:true,data:{messages:[groupMessage("late","2026-01-02T00:00:00Z")],has_more:false,has_more_after:true}});
  expect(await request).toBe(false);expect(useGroupDMStore.getState().messages).toEqual({});expect(useGroupDMStore.getState().groupsReady).toBe(false);expect(useGroupDMStore.getState().scrollTarget).toBeNull();
});

it("buffers live group messages while detached and returns to a contiguous latest window",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});
  vi.mocked(api.getGroupDMMessagesAround).mockResolvedValueOnce({success:true,data:{messages:[groupMessage("anchor","2026-01-01T00:00:00Z")],has_more:true,has_more_after:true}});
  expect(await useGroupDMStore.getState().fetchMessagesAround("g1","anchor")).toBe(true);
  await useGroupDMStore.getState().handleMessage(groupMessage("live","2026-01-04T00:00:00Z"));
  expect(useGroupDMStore.getState().messages.g1.map(message=>message.id)).toEqual(["anchor"]);
  expect(useGroupDMStore.getState().hasMoreAfterByGroup.g1).toBe(true);
  vi.mocked(api.listGroupDMMessages).mockResolvedValueOnce({success:true,data:{messages:[groupMessage("tail","2026-01-03T00:00:00Z"),groupMessage("live","2026-01-04T00:00:00Z")]}});
  useGroupDMStore.getState().jumpToPresent("g1");
  await vi.waitFor(()=>expect(useGroupDMStore.getState().hasMoreAfterByGroup.g1).toBe(false));
  expect(useGroupDMStore.getState().messages.g1.map(message=>message.id)).toEqual(["tail","live"]);
  expect(api.markGroupDMRead).not.toHaveBeenCalled();
});

it("applies a successful member addition only with the new key epoch and membership",async()=>{
  const current=group("g1");useGroupDMStore.setState({groups:[current]});
  vi.mocked(api.addGroupDMMember).mockResolvedValueOnce({success:true,data:{...current,key_epoch:2,members:[publicMember("new-member")]}});
  expect(await useGroupDMStore.getState().addMember("g1","new-member")).toBe(true);
  expect(api.addGroupDMMember).toHaveBeenCalledWith("g1","new-member",expect.objectContaining({expectedUserId:"me",isCurrent:expect.any(Function)}));
  expect(useGroupDMStore.getState().groups[0]).toMatchObject({key_epoch:2,members:[{id:"new-member"}]});
});

it("ignores a member removal response after the group lifetime ends and serializes mutations",async()=>{
  const current={...group("g1"),members:[publicMember("friend")]};useGroupDMStore.setState({groups:[current]});
  let finish!:(value:Awaited<ReturnType<typeof api.removeGroupDMMember>>)=>void;
  vi.mocked(api.removeGroupDMMember).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
  const first=useGroupDMStore.getState().removeMember("g1","friend");
  expect(await useGroupDMStore.getState().removeMember("g1","friend")).toBe(false);
  expect(api.removeGroupDMMember).toHaveBeenCalledOnce();
  expect(api.removeGroupDMMember).toHaveBeenCalledWith("g1","friend",expect.objectContaining({expectedUserId:"me",isCurrent:expect.any(Function)}));
  useGroupDMStore.getState().handleDelete("g1");
  finish({success:true,data:{...current,key_epoch:2,members:[]}});
  expect(await first).toBe(false);
  expect(useGroupDMStore.getState().groups).toEqual([]);
});

it("ignores a membership response after same-account reauthentication",async()=>{
  const current=group("g1");useGroupDMStore.setState({groups:[current]});
  let finish!:(value:Awaited<ReturnType<typeof api.addGroupDMMember>>)=>void;
  vi.mocked(api.addGroupDMMember).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
  const request=useGroupDMStore.getState().addMember("g1","new-member");
  setTokens("new-access-token","","me");
  finish({success:true,data:{...current,key_epoch:2,members:[publicMember("new-member")]}});
  expect(await request).toBe(false);
  expect(useGroupDMStore.getState().groups).toEqual([]);expect(useGroupDMStore.getState().groupsReady).toBe(false);
});

it("leaves the group only after a current successful response",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});
  vi.mocked(api.leaveGroupDM).mockResolvedValueOnce({success:true});
  expect(await useGroupDMStore.getState().leave("g1")).toBe(true);
  expect(api.leaveGroupDM).toHaveBeenCalledWith("g1",expect.objectContaining({expectedUserId:"me",isCurrent:expect.any(Function)}));
  expect(useGroupDMStore.getState().groups).toEqual([]);
});
const sentMessage=()=>({id:"saved",group_id:"g1",user_id:"me",ciphertext:"[]",created_at:"2026-10-24T00:00:00Z",attachments:[]} as unknown as GroupDMMessage);
it("awaits durable storage before its first POST and preserves a failed storage attempt without transmitting",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});let stored!:()=>void;
  vi.mocked(savePendingGroupSend).mockReturnValueOnce(new Promise(resolve=>{stored=resolve}));vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:true,data:sentMessage()});
  const sending=useGroupDMStore.getState().send("g1","original");await vi.waitFor(()=>expect(savePendingGroupSend).toHaveBeenCalledOnce());expect(api.sendGroupDMMessage).not.toHaveBeenCalled();
  stored();expect(await sending).toBe(true);expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(removePendingGroupSend).toHaveBeenCalledWith("me","device","g1",vi.mocked(api.sendGroupDMMessage).mock.calls[0][1].client_request_id);
  vi.mocked(savePendingGroupSend).mockRejectedValueOnce(new DOMException("full","QuotaExceededError"));expect(await useGroupDMStore.getState().send("g1","another")).toBe(false);
  expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(useGroupDMStore.getState().pendingSends.g1).toMatchObject({stored:false,busy:false,content:"another"});expect(useGroupDMStore.getState().error).toBe("groupSendStorageFailed");
});
it("reports a committed message as committed when local cleanup fails and retries cleanup without another POST",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:true,data:sentMessage()});vi.mocked(removePendingGroupSend).mockRejectedValueOnce(new Error("storage unavailable"));
  expect(await useGroupDMStore.getState().send("g1","original")).toBe(true);const id=useGroupDMStore.getState().pendingSends.g1!.id;
  expect(useGroupDMStore.getState().error).toBe("groupSendCleanupFailed");expect(useGroupDMStore.getState().messages.g1[0].content).toBe("original");
  vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:true,data:outcome(id,"completed",sentMessage())});expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(true);
  expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(savePendingGroupSend).toHaveBeenCalledOnce();expect(removePendingGroupSend).toHaveBeenCalledTimes(2);expect(useGroupDMStore.getState().pendingSends.g1).toBeUndefined();
});
it("never replays a known committed send when later result lookup reports missing or prepared",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:true,data:sentMessage()});vi.mocked(removePendingGroupSend).mockRejectedValueOnce(new Error("storage unavailable"));
  expect(await useGroupDMStore.getState().send("g1","original")).toBe(true);const pending=useGroupDMStore.getState().pendingSends.g1!;
  expect(pending).toMatchObject({resultConfirmed:true,lookupOnly:true,busy:false});
  vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:false,status:404});expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(false);
  expect(useGroupDMStore.getState().error).toBe("groupSendCommittedLookupPending");
  vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:true,data:outcome(pending.id,"prepared")});expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(false);
  expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(useGroupDMStore.getState().pendingSends.g1?.resultConfirmed).toBe(true);
});
it("retains the original record and live lookup-only fence when confirmation persistence fails",async()=>{
 useGroupDMStore.setState({groups:[group("g1")]});vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:true,data:sentMessage()});vi.mocked(markPendingGroupSendConfirmed).mockRejectedValueOnce(new DOMException("full","QuotaExceededError"));
 expect(await useGroupDMStore.getState().send("g1","original")).toBe(true);expect(removePendingGroupSend).not.toHaveBeenCalled();expect(useGroupDMStore.getState().pendingSends.g1).toMatchObject({resultConfirmed:true,lookupOnly:true,busy:false});expect(useGroupDMStore.getState().error).toBe("groupSendCleanupFailed");
});
it("keeps a partial snapshot until a failed-files-only child send is durably recorded and committed",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});const file=new File(["private"],"failed.txt");
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:true,status:207,data:{message:sentMessage(),upload_failures:[{filename:"encrypted_0.bin",file_key_index:0,error:"failed"}]}});
  expect(await useGroupDMStore.getState().send("g1","original",undefined,[file])).toBe(true);expect(removePendingGroupSend).not.toHaveBeenCalled();
  const source=useGroupDMStore.getState().uploadRecoveries.g1[0];expect(source.durable?.id).toBe(vi.mocked(api.sendGroupDMMessage).mock.calls[0][1].client_request_id);
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:true,data:{...sentMessage(),id:"child",attachments:[{filename:"encrypted_0.bin",file_key_index:0} as GroupDMMessage["attachments"][number]]}});expect(await useGroupDMStore.getState().retryUploadRecovery("g1",source.id)).toBe(true);
  const child=vi.mocked(savePendingGroupSend).mock.calls[1][0];expect(child.origin).toEqual({deviceId:"device",id:source.durable!.id});expect(child.content).toBe("");expect(child.files).toEqual([file]);
  expect(vi.mocked(removePendingGroupSend).mock.calls.map(call=>call[3])).toEqual([child.id]);
  expect(acknowledgePendingGroupFileChain).toHaveBeenCalledWith("me","device","g1",source.durable!.id,[0],expect.any(Function));
});
it("retains a confirmed child on source receipt failure and finishes by lookup without retransmission",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});const file=new File(["private"],"retry.txt");
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:true,status:207,data:{message:sentMessage(),upload_failures:[{filename:"encrypted_0.bin",file_key_index:0,error:"failed"}]}});
  await useGroupDMStore.getState().send("g1","original",undefined,[file]);const source=useGroupDMStore.getState().uploadRecoveries.g1[0];
  const childMessage={...sentMessage(),id:"child",attachments:[{filename:"encrypted_0.bin",file_key_index:0} as GroupDMMessage["attachments"][number]]};
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:true,status:201,data:childMessage});vi.mocked(acknowledgePendingGroupFileChain).mockRejectedValueOnce(new Error("pending_send_not_found"));
  expect(await useGroupDMStore.getState().retryUploadRecovery("g1",source.id)).toBe(true);
  const child=useGroupDMStore.getState().pendingSends.g1!;expect(child).toMatchObject({busy:false,resultConfirmed:true,lookupOnly:true});expect(useGroupDMStore.getState().error).toBe("groupSendSourceRecoveryFailed");expect(removePendingGroupSend).not.toHaveBeenCalled();
  const result=outcome(child.id,"completed",childMessage);result.operation.file_count=1;vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:true,data:result});
  expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(true);expect(api.sendGroupDMMessage).toHaveBeenCalledTimes(2);expect(useGroupDMStore.getState().pendingSends.g1).toBeUndefined();expect(removePendingGroupSend).toHaveBeenCalledWith("me","device","g1",child.id);
});
it("restores a dismissed durable file recovery when deletion fails",async()=>{
  const recovery={id:"r",messageId:"saved",files:[new File(["private"],"failed.txt")],retrying:false,retryable:true,durable:{accountId:"me",deviceId:"device",groupId:"g1",id:"request-00000001"}};
  useGroupDMStore.setState({groups:[group("g1")],uploadRecoveries:{g1:[recovery]}});vi.mocked(removePendingGroupSend).mockRejectedValueOnce(new Error("storage unavailable"));
  useGroupDMStore.getState().dismissUploadRecovery("g1","r");await vi.waitFor(()=>expect(useGroupDMStore.getState().uploadRecoveries.g1).toEqual([recovery]));expect(useGroupDMStore.getState().error).toBe("groupSendCleanupFailed");
});

it("retains the exact encrypted request/files and does not replace a newer draft on retry",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});const file=new File(["plain"],"private.txt");
  const key=composerKey("me","group","g1");useComposerDraftStore.getState().patch(key,{content:"original",files:[file]});
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true}).mockResolvedValueOnce({success:true,data:sentMessage()});
  expect(await useGroupDMStore.getState().send("g1","original",undefined,[file])).toBe(false);
  const pending=useGroupDMStore.getState().pendingSends.g1!;expect(pending.busy).toBe(false);expect(pending.id).toMatch(/^[a-zA-Z0-9_-]{16,128}$/);
  useComposerDraftStore.getState().patch(key,{content:"new draft",files:[]});
  vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:false,status:404});
  expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(true);
  expect(api.sendGroupDMMessage).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.sendGroupDMMessage).mock.calls[1][1]).toBe(vi.mocked(api.sendGroupDMMessage).mock.calls[0][1]);
  expect(vi.mocked(api.sendGroupDMMessage).mock.calls[1][2]).toBe(vi.mocked(api.sendGroupDMMessage).mock.calls[0][2]);
  expect(encryptGroupDMMessage).toHaveBeenCalledOnce();expect(encryptFilesForE2EE).toHaveBeenCalledOnce();
  expect(useComposerDraftStore.getState().drafts[key].content).toBe("new draft");expect(useGroupDMStore.getState().pendingSends.g1).toBeUndefined();
});

it("does not let an explicit scoped send retry a matching uncertain composer operation or clear its draft",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});
  const key=composerKey("me","group","g1");
  useComposerDraftStore.getState().patch(key,{content:"same text",groupReplyToId:"reply-1"});
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});
  expect(await useGroupDMStore.getState().send("g1","same text","reply-1")).toBe(false);
  const pending=useGroupDMStore.getState().pendingSends.g1!;
  const draftBefore=useComposerDraftStore.getState().drafts[key];
  expect(await useGroupDMStore.getState().send("g1","same text","reply-1",undefined,{ownerId:"me",authGeneration:getAuthGeneration(),isCurrent:()=>true})).toBe(false);
  expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(api.getGroupSendOutcome).not.toHaveBeenCalled();
  expect(useGroupDMStore.getState().pendingSends.g1?.id).toBe(pending.id);
  expect(useComposerDraftStore.getState().drafts[key]).toEqual(draftBefore);
});

it("queries a completed send without reposting and clears only the unchanged original draft",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});const key=composerKey("me","group","g1");useComposerDraftStore.getState().patch(key,{content:"original",files:[]});
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isNetworkError:true});
  expect(await useGroupDMStore.getState().send("g1","original")).toBe(false);
  const id=useGroupDMStore.getState().pendingSends.g1!.id;
  vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:true,data:outcome(id,"completed",sentMessage())});
  expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(true);
  expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(useComposerDraftStore.getState().drafts[key].content).toBe("");
});

it("keeps 202 pending, explicitly reconciles committed state and locks concurrent retries",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});await useGroupDMStore.getState().send("g1","original");
  const id=useGroupDMStore.getState().pendingSends.g1!.id;
  let finish!:(value:Awaited<ReturnType<typeof api.getGroupSendOutcome>>)=>void;
  vi.mocked(api.getGroupSendOutcome).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
  const retry=useGroupDMStore.getState().retryPendingSend("g1");expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(false);
  vi.mocked(api.reconcileGroupSend).mockResolvedValueOnce({success:true,status:202,data:outcome(id,"committed",sentMessage())});
  finish({success:true,data:outcome(id,"committed",sentMessage())});expect(await retry).toBe(false);
  expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(api.reconcileGroupSend).toHaveBeenCalledOnce();
  expect(useGroupDMStore.getState().pendingSends.g1).toMatchObject({id,busy:false});expect(useGroupDMStore.getState().messages.g1).toBeUndefined();
});

it("does not stamp original plaintext/file keys onto an edited replay",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});await useGroupDMStore.getState().send("g1","original");
  const id=useGroupDMStore.getState().pendingSends.g1!.id;
  vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:true,data:outcome(id,"completed",{...sentMessage(),ciphertext:"new cipher",content:null})});
  vi.mocked(decryptGroupDMMessages).mockResolvedValueOnce([{...sentMessage(),ciphertext:"new cipher",content:"edited elsewhere"}]);
  expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(true);
  expect(cacheDecryptedMessage).not.toHaveBeenCalled();expect(useGroupDMStore.getState().messages.g1[0].content).toBe("edited elsewhere");
});
it("does not silently substitute an unresolved old send for a new caller's message",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});await useGroupDMStore.getState().send("g1","original");
  expect(await useGroupDMStore.getState().send("g1","different draft")).toBe(false);
  expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(api.getGroupSendOutcome).not.toHaveBeenCalled();
});
it("handles an own-message WebSocket echo before the HTTP reply without losing the local plaintext",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});let finish!:(value:Awaited<ReturnType<typeof api.sendGroupDMMessage>>)=>void;
  vi.mocked(api.sendGroupDMMessage).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));const sending=useGroupDMStore.getState().send("g1","original");
  await vi.waitFor(()=>expect(api.sendGroupDMMessage).toHaveBeenCalledOnce());await useGroupDMStore.getState().handleMessage(sentMessage());
  finish({success:true,data:sentMessage()});expect(await sending).toBe(true);
  expect(useGroupDMStore.getState().messages.g1[0].content).toBe("original");expect(useGroupDMStore.getState().messages.g1).toHaveLength(1);
});
it("does not resume the old encrypted request after the local device changes",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});await useGroupDMStore.getState().send("g1","original");
  useE2EEStore.setState({localDeviceId:"other-device"});expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(false);
  expect(api.getGroupSendOutcome).not.toHaveBeenCalled();expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();
});
it("adopts a confirmed old-device result after new-device restoration without another send",async()=>{
 useGroupDMStore.setState({groups:[group("g1")]});vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});await useGroupDMStore.getState().send("g1","original");const id=useGroupDMStore.getState().pendingSends.g1!.id;
 useE2EEStore.setState({localDeviceId:"replacement-device"});await useGroupDMStore.getState().restorePendingSends(true);
 vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:true,data:outcome(id,"completed",sentMessage())});expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(true);
 expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(encryptGroupDMMessage).toHaveBeenCalledOnce();expect(useGroupDMStore.getState().messages.g1[0].content).toBe("original");expect(useGroupDMStore.getState().pendingSends.g1).toBeUndefined();
});
it("retains a missing old-device request with a permanent no-replay fence",async()=>{
 useGroupDMStore.setState({groups:[group("g1")]});vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});await useGroupDMStore.getState().send("g1","original");
 useE2EEStore.setState({localDeviceId:"replacement-device"});await useGroupDMStore.getState().restorePendingSends(true);vi.mocked(api.getGroupSendOutcome).mockResolvedValue({success:false,status:404});
 expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(false);expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(false);expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();expect(useGroupDMStore.getState().pendingSends.g1).toMatchObject({lookupOnly:true,busy:false});
});
it("cancels an uncommitted request after device change, preserving newer text and removed original files for review",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});const file=new File(["private"],"original.txt"),key=composerKey("me","group","g1");
  useComposerDraftStore.getState().patch(key,{content:"original",files:[file]});
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});await useGroupDMStore.getState().send("g1","original",undefined,[file]);
  const id=useGroupDMStore.getState().pendingSends.g1!.id;
  useComposerDraftStore.getState().patch(key,{content:"new draft",files:[]});useE2EEStore.setState({localDeviceId:"new-device"});
  vi.mocked(api.cancelGroupSend).mockResolvedValueOnce({success:true,data:outcome(id,"cancelled")});
  expect(await useGroupDMStore.getState().cancelPendingSend("g1")).toBe(true);
  expect(api.cancelGroupSend).toHaveBeenCalledWith("g1",id,expect.objectContaining({timeoutMs:15000}));expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();
  expect(useGroupDMStore.getState().pendingSends.g1).toBeUndefined();expect(useComposerDraftStore.getState().drafts[key].content).toBe("new draft");
  expect(useGroupDMStore.getState().uploadRecoveries.g1[0]).toMatchObject({files:[file],cancelled:true,retryable:false});
  await useGroupDMStore.getState().restorePendingSends(true);
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:true,data:{...sentMessage(),ciphertext:"[]"}});
  expect(await useGroupDMStore.getState().send("g1","new draft")).toBe(true);
  expect(vi.mocked(api.sendGroupDMMessage).mock.calls[1][1].client_request_id).not.toBe(id);
});
it("blocks sends until ready-device restoration succeeds and preserves unreadable group records",async()=>{
  useGroupDMStore.setState({groups:[group("g1")],restoreStatus:"idle"});
  expect(await useGroupDMStore.getState().send("g1","new")).toBe(false);expect(encryptGroupDMMessage).not.toHaveBeenCalled();
  vi.mocked(loadGroupSendRestorePlan).mockResolvedValueOnce({groups:{},blocked:[{groupId:"g1",reason:"unreadable"}],unavailable:[]});await useGroupDMStore.getState().restorePendingSends();
  expect(useGroupDMStore.getState().restoreBlocked).toEqual(["g1"]);expect(await useGroupDMStore.getState().send("g1","new")).toBe(false);expect(api.sendGroupDMMessage).not.toHaveBeenCalled();
  vi.mocked(loadGroupSendRestorePlan).mockRejectedValueOnce(new Error("key missing"));await useGroupDMStore.getState().restorePendingSends(true);expect(useGroupDMStore.getState().restoreStatus).toBe("error");
  await useGroupDMStore.getState().restorePendingSends(true);expect(useGroupDMStore.getState().restoreStatus).toBe("ready");expect(useGroupDMStore.getState().restoreBlocked).toEqual([]);
});
it("ignores restoration finishing after account change",async()=>{
  useGroupDMStore.setState({groups:[group("g1")],restoreStatus:"idle"});let finish!:(value:Awaited<ReturnType<typeof loadGroupSendRestorePlan>>)=>void;
  vi.mocked(loadGroupSendRestorePlan).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));const restoring=useGroupDMStore.getState().restorePendingSends();
  useAuthStore.setState({user:{id:"next-account"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>});finish({groups:{},blocked:[],unavailable:[]});await restoring;
  expect(useGroupDMStore.getState().restoreStatus).toBe("idle");expect(useGroupDMStore.getState().pendingSends).toEqual({});expect(useGroupDMStore.getState().groupsReady).toBe(false);
});
it.each(["unknown","committed"])("does not claim cancellation or drop the pending request when cancellation is %s",async(mode)=>{
  useGroupDMStore.setState({groups:[group("g1")]});vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});await useGroupDMStore.getState().send("g1","original");const id=useGroupDMStore.getState().pendingSends.g1!.id;
  vi.mocked(api.cancelGroupSend).mockResolvedValueOnce(mode==="unknown"?{success:false,isTimeout:true}:{success:true,data:outcome(id,"committed",sentMessage())});
  expect(await useGroupDMStore.getState().cancelPendingSend("g1")).toBe(false);expect(useGroupDMStore.getState().pendingSends.g1).toMatchObject({id,busy:false});expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();
});
it("resolves a completed old-epoch send after a membership rekey without encrypting again",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:false,isTimeout:true});await useGroupDMStore.getState().send("g1","original");
  const id=useGroupDMStore.getState().pendingSends.g1!.id;useGroupDMStore.getState().handleCreateOrUpdate(group("g1",2));
  vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:true,data:outcome(id,"completed",sentMessage())});
  expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(true);expect(encryptGroupDMMessage).toHaveBeenCalledOnce();expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();
});
it.each(["edit","delete"])("does not overwrite a newer live %s with the older HTTP send reply",async(change)=>{
  useGroupDMStore.setState({groups:[group("g1")]});let finish!:(value:Awaited<ReturnType<typeof api.sendGroupDMMessage>>)=>void;
  vi.mocked(api.sendGroupDMMessage).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));const sending=useGroupDMStore.getState().send("g1","original");
  await vi.waitFor(()=>expect(api.sendGroupDMMessage).toHaveBeenCalledOnce());
  if(change==="edit")await useGroupDMStore.getState().handleMessageUpdate({...sentMessage(),ciphertext:"new cipher",content:"edited elsewhere"});else useGroupDMStore.getState().handleMessageDelete("g1","saved");
  finish({success:true,data:sentMessage()});expect(await sending).toBe(true);expect(cacheDecryptedMessage).not.toHaveBeenCalled();
  if(change==="edit")expect(useGroupDMStore.getState().messages.g1[0].content).toBe("edited elsewhere");else expect(useGroupDMStore.getState().messages.g1??[]).toEqual([]);
});

it("does not resend deleted outcomes, and destroys pending requests on account or membership removal",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});vi.mocked(api.sendGroupDMMessage).mockResolvedValue({success:false,isTimeout:true});await useGroupDMStore.getState().send("g1","original");
  let id=useGroupDMStore.getState().pendingSends.g1!.id;
  vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:true,data:outcome(id,"deleted")});
  expect(await useGroupDMStore.getState().retryPendingSend("g1")).toBe(false);expect(useGroupDMStore.getState().pendingSends.g1).toBeUndefined();expect(api.sendGroupDMMessage).toHaveBeenCalledOnce();
  await useGroupDMStore.getState().send("g1","another");useGroupDMStore.getState().handleDelete("g1");expect(useGroupDMStore.getState().pendingSends.g1).toBeUndefined();
  useGroupDMStore.setState({groups:[group("g1")]});await useGroupDMStore.getState().send("g1","last");id=useGroupDMStore.getState().pendingSends.g1!.id;
  useAuthStore.setState({user:{id:"different"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>});expect(useGroupDMStore.getState().pendingSends).toEqual({});expect(id).toBeTruthy();
});
it("treats 207 as a committed message and retries only failed files without the original text",async()=>{
  const files=[new File(["a"],"first.txt"),new File(["b"],"second.txt")];
  const saved={id:"saved",group_id:"g1",user_id:"me",ciphertext:"[]",created_at:"2026-10-24T00:00:00Z",attachments:[{id:"second",filename:"encrypted_1.bin",file_key_index:1}]} as GroupDMMessage;
  useGroupDMStore.setState({groups:[group("g1")]});
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:true,status:207,data:{message:saved,upload_failures:[{filename:"encrypted_0.bin",error:"failed",file_key_index:0}]}}).mockResolvedValueOnce({success:true,data:{...saved,id:"retried",attachments:[]}});
  expect(await useGroupDMStore.getState().send("g1","original text",undefined,files)).toBe(true);
  const recovery=useGroupDMStore.getState().uploadRecoveries.g1[0];
  expect(recovery).toMatchObject({messageId:"saved",files:[files[0]],retryable:true,retrying:false});
  expect(await useGroupDMStore.getState().retryUploadRecovery("g1",recovery.id)).toBe(true);
  expect(api.sendGroupDMMessage).toHaveBeenCalledTimes(2);
  expect(JSON.parse(vi.mocked(encryptGroupDMMessage).mock.calls[1][3]).content).toBe("");
  expect(vi.mocked(encryptFilesForE2EE).mock.calls[1][0]).toEqual([files[0]]);
  expect(useGroupDMStore.getState().uploadRecoveries.g1).toEqual([]);
  expect(useGroupDMStore.getState().messages.g1.map(m=>m.content)).toEqual(["","original text"]);
});
it("requires explicit file review for unverifiable failure indices without discarding newer drafts",async()=>{
  const files=[new File(["a"],"one.txt"),new File(["b"],"two.txt")];
  useGroupDMStore.setState({groups:[group("g1")]});
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:true,status:207,data:{message:{id:"saved",group_id:"g1",user_id:"me"} as GroupDMMessage,upload_failures:[{filename:"opaque",error:"unknown"}]}});
  expect(await useGroupDMStore.getState().send("g1","body",undefined,files)).toBe(true);
  const recovery=useGroupDMStore.getState().uploadRecoveries.g1[0];expect(recovery.retryable).toBe(false);
  expect(await useGroupDMStore.getState().retryUploadRecovery("g1",recovery.id)).toBe(false);
  expect(api.sendGroupDMMessage).toHaveBeenCalledTimes(1);
  const key=composerKey("me","group","g1");useComposerDraftStore.getState().patch(key,{content:"new draft"});
  expect(useGroupDMStore.getState().restoreUploadRecovery("g1",recovery.id)).toBe(true);
  expect(useComposerDraftStore.getState().drafts[key]).toMatchObject({content:"new draft",files});
  expect(useGroupDMStore.getState().uploadRecoveries.g1).toEqual([]);
});
it("locks duplicate upload retries and retains failed files for another attempt",async()=>{
  const file=new File(["x"],"retry.txt");
  useGroupDMStore.setState({groups:[group("g1")],uploadRecoveries:{g1:[{id:"r",messageId:"saved",files:[file],retryable:true,retrying:false}]}});
  let finish!:(value:Awaited<ReturnType<typeof api.sendGroupDMMessage>>)=>void;
  vi.mocked(api.sendGroupDMMessage).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
  const pending=useGroupDMStore.getState().retryUploadRecovery("g1","r");
  expect(await useGroupDMStore.getState().retryUploadRecovery("g1","r")).toBe(false);
  await vi.waitFor(()=>expect(api.sendGroupDMMessage).toHaveBeenCalledOnce());
  finish({success:false,error:"offline"});expect(await pending).toBe(false);
  expect(useGroupDMStore.getState().uploadRecoveries.g1[0]).toMatchObject({files:[file],retrying:false});
  useAuthStore.setState({user:{id:"different"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>});
  expect(useGroupDMStore.getState().uploadRecoveries).toEqual({});
});

it.each(["account","membership","rekey"])("discards loaded history after %s changes",async(change)=>{
  useGroupDMStore.setState({groups:[group("g1")]});
  let finish!:(value:Awaited<ReturnType<typeof api.listGroupDMMessages>>)=>void;
  vi.mocked(api.listGroupDMMessages).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
  const pending=useGroupDMStore.getState().fetchMessages("g1");
  if(change==="account")useAuthStore.setState({user:{id:"second"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>});
  else if(change==="membership")useGroupDMStore.getState().handleDelete("g1");
  else useGroupDMStore.getState().handleCreateOrUpdate(group("g1",2));
  finish({success:true,data:{messages:[{id:"old",group_id:"g1",content:"old account plaintext"} as GroupDMMessage]}});
  await pending;
  expect(useGroupDMStore.getState().messages.g1).toBeUndefined();
  expect(decryptGroupDMMessages).not.toHaveBeenCalled();
});
it("merges history without erasing live messages or resurrecting edits/deletions",async()=>{
  const message=(id:string,content:string)=>({id,group_id:"g1",user_id:"other",content,created_at:"2026-10-24T00:00:00Z"} as GroupDMMessage);
  useGroupDMStore.setState({groups:[group("g1")],messages:{g1:[message("edited","old"),message("deleted","old")]}});
  let finish!:(value:Awaited<ReturnType<typeof api.listGroupDMMessages>>)=>void;
  vi.mocked(api.listGroupDMMessages).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
  const pending=useGroupDMStore.getState().fetchMessages("g1");
  await useGroupDMStore.getState().handleMessageUpdate(message("edited","new"));
  await useGroupDMStore.getState().handleMessage(message("live","new message"));
  useGroupDMStore.getState().handleMessageDelete("g1","deleted");
  finish({success:true,data:{messages:[message("edited","old"),message("deleted","old"),message("history","older history")]}});
  await pending;
  expect(useGroupDMStore.getState().messages.g1.map(m=>[m.id,m.content])).toEqual([["edited","new"],["history","older history"],["live","new message"]]);
});
it("does not resurrect a deleted message when pending decryption finishes",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});
  let finish!:(messages:GroupDMMessage[])=>void;
  vi.mocked(decryptGroupDMMessages).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
  const message={id:"pending",group_id:"g1",content:"body"} as GroupDMMessage;
  const pending=useGroupDMStore.getState().handleMessage(message);
  useGroupDMStore.getState().handleMessageDelete("g1","pending");
  finish([message]);await pending;
  expect(useGroupDMStore.getState().messages.g1).toEqual([]);
});
it.each(["account","membership","rekey","device"])("does not send stale ciphertext after %s changes during encryption",async(change)=>{
  useGroupDMStore.setState({groups:[group("g1")]});
  let finish!:(value:Awaited<ReturnType<typeof encryptGroupDMMessage>>)=>void;
  vi.mocked(encryptGroupDMMessage).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
  const pending=useGroupDMStore.getState().send("g1","private body");
  if(change==="account")useAuthStore.setState({user:{id:"second"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>});
  else if(change==="membership")useGroupDMStore.getState().handleDelete("g1");
  else if(change==="rekey")useGroupDMStore.getState().handleCreateOrUpdate(group("g1",2));
  else useE2EEStore.setState({localDeviceId:"different"});
  finish([]);expect(await pending).toBe(false);
  expect(api.sendGroupDMMessage).not.toHaveBeenCalled();expect(cacheDecryptedMessage).not.toHaveBeenCalled();
});
it("clears group cache provenance on same-account reauthentication",()=>{
  useGroupDMStore.setState({groups:[group("g1")],groupsReady:true});
  const oldGeneration=useGroupDMStore.getState().authGeneration;
  setTokens("same-owner-new-session","","me");
  expect(useGroupDMStore.getState()).toMatchObject({ownerId:"me",authGeneration:getAuthGeneration(),groups:[],groupsReady:false,messages:{}});
  expect(getAuthGeneration()).not.toBe(oldGeneration);
});
it("rejects a send callback captured before same-account reauthentication",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});
  const staleContext={ownerId:"me",authGeneration:getAuthGeneration()};
  setTokens("same-owner-new-session","","me");
  expect(await useGroupDMStore.getState().send("g1","private body",undefined,undefined,staleContext)).toBe(false);
  expect(encryptGroupDMMessage).not.toHaveBeenCalled();expect(savePendingGroupSend).not.toHaveBeenCalled();expect(api.sendGroupDMMessage).not.toHaveBeenCalled();
});
it("rechecks optional render scope after encryption and immediately before POST",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});
  let finish!:(value:Awaited<ReturnType<typeof encryptGroupDMMessage>>)=>void;
  vi.mocked(encryptGroupDMMessage).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
  let current=true;
  const request=useGroupDMStore.getState().send("g1","private body",undefined,undefined,{ownerId:"me",authGeneration:getAuthGeneration(),isCurrent:()=>current});
  await vi.waitFor(()=>expect(encryptGroupDMMessage).toHaveBeenCalledOnce());
  current=false;finish([]);
  expect(await request).toBe(false);expect(api.sendGroupDMMessage).not.toHaveBeenCalled();expect(savePendingGroupSend).not.toHaveBeenCalled();
});
it("does not POST when optional render scope expires while durable storage is pending",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});
  let finishStorage!:()=>void;let current=true;
  vi.mocked(savePendingGroupSend).mockReturnValueOnce(new Promise(resolve=>{finishStorage=resolve}));
  const request=useGroupDMStore.getState().send("g1","private body",undefined,undefined,{ownerId:"me",authGeneration:getAuthGeneration(),isCurrent:()=>current});
  await vi.waitFor(()=>expect(savePendingGroupSend).toHaveBeenCalledOnce());
  current=false;finishStorage();
  expect(await request).toBe(false);expect(api.sendGroupDMMessage).not.toHaveBeenCalled();
});
it("does not report a committed send as failed just because the local cache fails",async()=>{
  useGroupDMStore.setState({groups:[group("g1")]});
  vi.mocked(api.sendGroupDMMessage).mockResolvedValueOnce({success:true,data:{id:"sent",group_id:"g1",user_id:"me",ciphertext:"[]",created_at:"2026-10-24T00:00:00Z"} as GroupDMMessage});
  vi.mocked(cacheDecryptedMessage).mockRejectedValueOnce(new Error("disk full"));
  expect(await useGroupDMStore.getState().send("g1","sent content")).toBe(true);
  expect(useGroupDMStore.getState().messages.g1[0].content).toBe("sent content");
});
it("preserves encrypted attachment keys when editing the text",async()=>{
  const keys=[{key:"key",iv:"iv",filename:"image.png",mimeType:"image/png",originalSize:10,digest:"digest"}];
  const original={id:"m",group_id:"g1",user_id:"me",content:"old",e2ee_file_keys:keys} as GroupDMMessage;
  useGroupDMStore.setState({groups:[group("g1")],messages:{g1:[original]}});
  vi.mocked(api.editGroupDMMessage).mockResolvedValueOnce({success:true,data:{...original,content:null}});
  expect(await useGroupDMStore.getState().edit("g1","m","new")).toBe(true);
  expect(JSON.parse(vi.mocked(encryptGroupDMMessage).mock.calls[0][3])).toEqual({content:"new",file_keys:keys});
  expect(useGroupDMStore.getState().messages.g1[0]).toMatchObject({content:"new",e2ee_file_keys:keys});
});

it("applies confirmed unread state and ignores older, duplicate and invalid read events",async()=>{
  useGroupDMStore.setState({groups:[{...group("g1"),read_revision:2,unread_count:0}]});
  vi.mocked(api.markGroupDMUnread).mockResolvedValue({success:true,data:{group_id:"g1",last_read_message_id:null,unread_count:3,revision:4}});
  expect(await useGroupDMStore.getState().markUnread("g1","m1")).toBe(true);
  for(const state of [{unread_count:0,revision:3},{unread_count:0,revision:4},{unread_count:0},{unread_count:-1,revision:9}]) useGroupDMStore.getState().handleReadState({group_id:"g1",last_read_message_id:null,...state});
  expect(useGroupDMStore.getState().groups[0]).toMatchObject({unread_count:3,read_revision:4});
  useGroupDMStore.getState().handleReadState({group_id:"g1",last_read_message_id:"m1",unread_count:0,revision:5});
  expect(useGroupDMStore.getState().groups[0].unread_count).toBe(0);
});
it("preserves newer websocket counts across a stale group refresh",async()=>{
  useGroupDMStore.setState({groups:[{...group("g1"),read_revision:10,unread_count:7}]});
  vi.mocked(api.listGroupDMs).mockResolvedValue({success:true,data:{group_dms:[{...group("g1"),read_revision:9,unread_count:0}]}});
  await useGroupDMStore.getState().fetchGroups();
  useGroupDMStore.getState().handleCreateOrUpdate({...group("g1"),read_revision:8,unread_count:0});
  expect(useGroupDMStore.getState().groups[0]).toMatchObject({unread_count:7,read_revision:10});
});
it("does not change counts on failed or wrong-group unread responses",async()=>{
  useGroupDMStore.setState({groups:[{...group("g1"),unread_count:6}]});
  vi.mocked(api.markGroupDMUnread).mockResolvedValueOnce({success:false,error:"forbidden"}).mockResolvedValueOnce({success:true,data:{group_id:"g2",last_read_message_id:null,unread_count:0,revision:1}});
  expect(await useGroupDMStore.getState().markUnread("g1","m1")).toBe(false);
  expect(await useGroupDMStore.getState().markUnread("g1","m1")).toBe(false);
  expect(useGroupDMStore.getState().groups[0].unread_count).toBe(6);
});
it.each(["account","membership"])("discards a read response after %s changes",async(change)=>{
  useGroupDMStore.setState({groups:[{...group("g1"),unread_count:6}]});
  let finish!:(value:Awaited<ReturnType<typeof api.markGroupDMUnread>>)=>void;
  vi.mocked(api.markGroupDMUnread).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
  const pending=useGroupDMStore.getState().markUnread("g1","m1");
  if(change==="account")useAuthStore.setState({user:{id:"second"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>});
  else useGroupDMStore.getState().handleDelete("g1");
  finish({success:true,data:{group_id:"g1",last_read_message_id:null,unread_count:8,revision:11}});
  expect(await pending).toBe(false);
  expect(useGroupDMStore.getState().groups[0]?.unread_count).toBeUndefined();
});
it("does not let a late read response overwrite a later unread intent or websocket revision",async()=>{
  useGroupDMStore.setState({groups:[{...group("g1"),unread_count:6,read_revision:1}]});
  let finish!:(value:Awaited<ReturnType<typeof api.markGroupDMRead>>)=>void;
  vi.mocked(api.markGroupDMRead).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
  const pending=useGroupDMStore.getState().markRead("g1","m1");
  vi.mocked(api.markGroupDMUnread).mockResolvedValueOnce({success:true,data:{group_id:"g1",last_read_message_id:null,unread_count:7,revision:3}});
  expect(await useGroupDMStore.getState().markUnread("g1","m2")).toBe(true);
  useGroupDMStore.getState().handleReadState({group_id:"g1",last_read_message_id:null,unread_count:8,revision:4});
  finish({success:true,data:{group_id:"g1",last_read_message_id:"m1",unread_count:0,revision:2}});
  await pending;
  expect(useGroupDMStore.getState().groups[0]).toMatchObject({unread_count:8,read_revision:4});
});

describe("group DM store", () => {
  it("loads and replaces the server-scoped group list", async () => {
    vi.mocked(api.listGroupDMs).mockResolvedValue({ success: true, data: { group_dms: [group("g1")] } });
    await useGroupDMStore.getState().fetchGroups();
    expect(useGroupDMStore.getState()).toMatchObject({ groups: [group("g1")], loading: false, error: null });
  });

  it("upserts membership rekeys without duplicating the group", () => {
    useGroupDMStore.setState({ groups: [group("g1", 1)] });
    useGroupDMStore.getState().handleCreateOrUpdate(group("g1", 2));
    expect(useGroupDMStore.getState().groups).toEqual([group("g1", 2)]);
  });

  it("deduplicates websocket message echoes", async () => {
    const message = { id: "m1", group_id: "g1", user_id: "u1", content: "hello" } as GroupDMMessage;
    useGroupDMStore.setState({groups:[group("g1")]});
    await useGroupDMStore.getState().handleMessage(message);
    await useGroupDMStore.getState().handleMessage(message);
    expect(useGroupDMStore.getState().messages.g1).toEqual([message]);
  });

  it("removes group messages when membership is revoked", () => {
    useGroupDMStore.setState({ groups: [group("g1")], messages: { g1: [{ id: "m1" } as GroupDMMessage] } });
    useGroupDMStore.getState().handleDelete("g1");
    expect(useGroupDMStore.getState()).toMatchObject({ groups: [], messages: {} });
  });

  it("deletes a message only after the server confirms", async()=>{
    const message={id:"m1",group_id:"g1"} as GroupDMMessage;useGroupDMStore.setState({messages:{g1:[message]}});
    vi.mocked(api.deleteGroupDMMessage).mockResolvedValue({success:false,error:"forbidden"});
    expect(await useGroupDMStore.getState().removeMessage("g1","m1")).toBe(false);expect(useGroupDMStore.getState().messages.g1).toEqual([message]);
    vi.mocked(api.deleteGroupDMMessage).mockResolvedValue({success:true});
    expect(await useGroupDMStore.getState().removeMessage("g1","m1")).toBe(true);expect(useGroupDMStore.getState().messages.g1).toEqual([]);
  });

  it("applies reaction and read websocket state", async()=>{
    const message={id:"m1",group_id:"g1",reactions:[]} as unknown as GroupDMMessage;useGroupDMStore.setState({groups:[group("g1")],messages:{g1:[message]}});
    useGroupDMStore.getState().handleReactionUpdate("g1","m1",[{emoji:"👍",count:1,users:["me"]}]);
    expect(useGroupDMStore.getState().messages.g1[0].reactions[0].count).toBe(1);
    vi.mocked(api.markGroupDMRead).mockResolvedValue({success:true});useGroupDMStore.setState({groups:[{...group("g1"),unread_count:4}]});await useGroupDMStore.getState().markRead("g1","m1");expect(useGroupDMStore.getState().groups[0].unread_count).toBe(0);
  });
});
