import type {PendingGroupSendSnapshot} from "../../crypto/pendingGroupSendStorage";
import {loadPendingGroupSends} from "../../crypto/pendingGroupSendStorage";

export type GroupSendRestorePlan={
 groups:Record<string,PendingGroupSendSnapshot[]>;
 blocked:Array<{groupId:string;reason:"unreadable"|"scope_mismatch"|"duplicate_request"|"dependency_cycle"}>;
 unavailable:Array<{groupId:string;id:string}>;
};

/** Pure planning only: no network, persistence mutation, draft replacement or
 * automatic replay. The caller must provide freshly authorized group IDs.
 * Child attempts precede their source even if the OS clock moved backward. */
export function planGroupSendRestore(sends:PendingGroupSendSnapshot[],failed:Array<{groupId:string;id:string}>,accountId:string,deviceId:string,allowedGroupIds:ReadonlySet<string>):GroupSendRestorePlan{
 const groups:Record<string,PendingGroupSendSnapshot[]>=Object.create(null) as Record<string,PendingGroupSendSnapshot[]>;
 const blocked=new Map<string,GroupSendRestorePlan["blocked"][number]["reason"]>();
 const unavailable:GroupSendRestorePlan["unavailable"]=[];
 const collected=new Map<string,Map<string,PendingGroupSendSnapshot>>();
 for(const record of failed){if(allowedGroupIds.has(record.groupId))blocked.set(record.groupId,"unreadable");else unavailable.push({...record})}
 for(const send of sends){
  if(!allowedGroupIds.has(send.groupId)){unavailable.push({groupId:send.groupId,id:send.id});continue}
  if(send.accountId!==accountId||send.deviceId!==deviceId){blocked.set(send.groupId,"scope_mismatch");continue}
  const group=collected.get(send.groupId)??new Map<string,PendingGroupSendSnapshot>();
  if(group.has(send.id)){blocked.set(send.groupId,"duplicate_request");continue}
  group.set(send.id,send);collected.set(send.groupId,group);
 }
 const compare=(a:PendingGroupSendSnapshot,b:PendingGroupSendSnapshot)=>a.createdAt-b.createdAt||(a.id<b.id?-1:a.id>b.id?1:0);
 const parents=(send:PendingGroupSendSnapshot)=>new Set([...(send.origin?[send.origin]:[]),...(send.fileSources??[])].filter(source=>source.deviceId===deviceId).map(source=>source.id));
 for(const [groupId,records]of collected){
  if(blocked.has(groupId))continue;
  const children=new Map(Array.from(records.keys(),id=>[id,0]));
  for(const send of records.values())for(const id of parents(send))if(records.has(id))children.set(id,children.get(id)!+1);
  let ready=Array.from(records.values()).filter(send=>children.get(send.id)===0).sort(compare);
  const ordered:PendingGroupSendSnapshot[]=[];
  while(ready.length){
   const next:PendingGroupSendSnapshot[]=[];
   for(const send of ready){
    ordered.push(send);
    for(const id of parents(send))if(records.has(id)){
     const remaining=children.get(id)!-1;children.set(id,remaining);if(remaining===0)next.push(records.get(id)!);
    }
   }
   ready=next.sort(compare);
  }
  if(ordered.length!==records.size){blocked.set(groupId,"dependency_cycle");continue}
  groups[groupId]=ordered;
 }
 return {groups,blocked:Array.from(blocked,([groupId,reason])=>({groupId,reason})).sort((a,b)=>a.groupId<b.groupId?-1:a.groupId>b.groupId?1:0),unavailable};
}

/** Read/decrypt and plan only. Never infer membership from local records. */
export async function loadGroupSendRestorePlan(accountId:string,deviceId:string,allowedGroupIds:ReadonlySet<string>,isCurrent:()=>boolean):Promise<GroupSendRestorePlan>{
 if(!isCurrent())throw new Error("pending_send_context_changed");
 const authorized=new Set(allowedGroupIds);
 const local=await loadPendingGroupSends(accountId,deviceId,isCurrent);
 if(!isCurrent())throw new Error("pending_send_context_changed");
 return planGroupSendRestore(local.sends,local.failed,accountId,deviceId,authorized);
}
