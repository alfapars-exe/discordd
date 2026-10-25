import {beforeEach,expect,it,vi} from "vitest";
import type {GroupSendOutcome} from "../../types/groupDM";
vi.mock("../../api/groupDM",()=>({getGroupSendOutcome:vi.fn(),reconcileGroupSend:vi.fn(),sendGroupDMMessage:vi.fn()}));
import * as api from "../../api/groupDM";
import {groupOutcomeResponse,retryGroupSend} from "./groupSendAttempt";
const payload:api.GroupSendPayload={client_request_id:"request-00000001",ciphertext:"unchanged",sender_device_id:"device",e2ee_metadata:"{}",key_epoch:1};
const pending=():GroupSendOutcome=>({operation:{group_id:"group",request_id:payload.client_request_id!,message_id:"message",file_count:1,failed_indices:[],phase:"prepared",created_at:"2026-10-24T00:00:00Z",updated_at:"2026-10-24T00:00:00Z"}});
beforeEach(()=>vi.resetAllMocks());
it.each([401,403,429,500,undefined])("does not repost after a failed lookup %s",async(status)=>{
 vi.mocked(api.getGroupSendOutcome).mockResolvedValue({success:false,status});
 await retryGroupSend("group",payload,undefined,()=>true);expect(api.sendGroupDMMessage).not.toHaveBeenCalled();expect(api.reconcileGroupSend).not.toHaveBeenCalled();
});
it("reposts the same prepared request and files without generating new encryption",async()=>{
 const files=[new File(["encrypted"],"encrypted_0.bin")];vi.mocked(api.getGroupSendOutcome).mockResolvedValue({success:true,data:pending()});
 vi.mocked(api.sendGroupDMMessage).mockResolvedValue({success:false,isTimeout:true});await retryGroupSend("group",payload,files,()=>true);
 expect(vi.mocked(api.sendGroupDMMessage).mock.calls[0][1]).toBe(payload);expect(vi.mocked(api.sendGroupDMMessage).mock.calls[0][2]).toBe(files);
});
it("does not continue after the context changes during lookup",async()=>{
 let current=true;vi.mocked(api.getGroupSendOutcome).mockImplementation(async()=>{current=false;return {success:false,status:404}});
 await retryGroupSend("group",payload,undefined,()=>current);expect(api.sendGroupDMMessage).not.toHaveBeenCalled();
});
it.each(["missing","prepared"])("does not replay old-device ciphertext for a %s operation",async(mode)=>{
 vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce(mode==="missing"?{success:false,status:404}:{success:true,data:pending()});
 expect(await retryGroupSend("group",payload,undefined,()=>true,false)).toMatchObject({success:false,error:"groupSendOldDevicePending"});expect(api.sendGroupDMMessage).not.toHaveBeenCalled();
});
it("allows explicit old-device committed-result reconciliation without transmitting files",async()=>{
 const out=pending();out.operation.phase="committed";vi.mocked(api.getGroupSendOutcome).mockResolvedValueOnce({success:true,data:out});vi.mocked(api.reconcileGroupSend).mockResolvedValueOnce({success:true,status:202,data:out});
 await retryGroupSend("group",payload,[new File(["encrypted"],"encrypted_0.bin")],()=>true,false);expect(api.reconcileGroupSend).toHaveBeenCalledWith("group",payload.client_request_id,expect.any(Object));expect(api.sendGroupDMMessage).not.toHaveBeenCalled();
});
it("normalizes indexed partial completion and rejects malformed/out-of-scope outcomes",()=>{
 const out=pending();out.operation.phase="completed";out.operation.failed_indices=[0];out.message={id:"message",group_id:"group"} as NonNullable<GroupSendOutcome["message"]>;
 expect(groupOutcomeResponse(out,"group",payload.client_request_id!)).toMatchObject({success:true,status:207,data:{upload_failures:[{file_key_index:0}]}});
 expect(groupOutcomeResponse(out,"other",payload.client_request_id!).success).toBe(false);
 out.operation.failed_indices=[0,0];expect(groupOutcomeResponse(out,"group",payload.client_request_id!).success).toBe(false);
 out.operation.failed_indices=[1];expect(groupOutcomeResponse(out,"group",payload.client_request_id!).success).toBe(false);
 out.operation.failed_indices=[];out.message.id="other";expect(groupOutcomeResponse(out,"group",payload.client_request_id!).success).toBe(false);
});
