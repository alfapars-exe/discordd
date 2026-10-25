import * as api from "../../api/groupDM";
import type { APIResponse } from "../../types/api";
import type { GroupSendOutcome,GroupSendResponse } from "../../types/groupDM";

/** Only normalize a validated final outcome; 202 never means send success. */
export function groupOutcomeResponse(out:GroupSendOutcome,groupId:string,id:string):APIResponse<GroupSendResponse>{
 const op=out.operation;
 if(!op||!["prepared","committed","completed","deleted","cancelled"].includes(op.phase)||op.group_id!==groupId||op.request_id!==id||!op.message_id||!Number.isSafeInteger(op.file_count)||op.file_count<0||op.file_count>10||!Array.isArray(op.failed_indices)||new Set(op.failed_indices).size!==op.failed_indices.length||op.failed_indices.some(i=>!Number.isSafeInteger(i)||i<0||i>=op.file_count))return {success:false,error:"groupSendInvalidOutcome"};
 if(op.phase==="cancelled")return {success:false,status:410,error:"groupSendCancelled"};
 if(op.phase==="deleted")return {success:false,status:410,error:"groupSendDeleted"};
 if(op.phase!=="completed")return {success:true,status:202,data:out};
 if(!out.message||out.message.id!==op.message_id||out.message.group_id!==groupId)return {success:false,error:"groupSendInvalidOutcome"};
 return op.failed_indices.length?{success:true,status:207,data:{message:out.message,upload_failures:op.failed_indices.map(i=>({filename:`encrypted_${i}.bin`,error:"upload failed",file_key_index:i}))}}:{success:true,status:201,data:out.message};
}

export async function retryGroupSend(groupId:string,payload:api.GroupSendPayload,files:File[]|undefined,isCurrent:()=>boolean,allowReplay=true):Promise<APIResponse<GroupSendResponse>>{
 const id=payload.client_request_id!;
 const scope={isCurrent,timeoutMs:15_000};
 const lookup=await api.getGroupSendOutcome(groupId,id,scope);
 if(!isCurrent())return {success:false};
 if(lookup.success&&lookup.data){
  const normalized=groupOutcomeResponse(lookup.data,groupId,id);
  if(!normalized.success||normalized.status!==202)return normalized;
  if(lookup.data.operation.phase==="committed")return api.reconcileGroupSend(groupId,id,scope);
  if(lookup.data.operation.phase!=="prepared")return {success:false,error:"groupSendInvalidOutcome"};
 }else if(lookup.status!==404)return lookup;
 // A missing/prepared operation can safely receive the EXACT same request.
 // Never fall back to an unkeyed write, including against an older server.
 if(!allowReplay)return {success:false,error:"groupSendOldDevicePending"};
 if(!isCurrent())return {success:false};
 return api.sendGroupDMMessage(groupId,payload,files,{isCurrent,timeoutMs:60_000});
}
