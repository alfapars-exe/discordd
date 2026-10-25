import {expect,it} from "vitest";
import type {PendingGroupSendSnapshot} from "../../crypto/pendingGroupSendStorage";
import {planGroupSendRestore} from "./groupSendRestoreQueue";
function snapshot(id:string,time=1,groupId="group",origin?:string):PendingGroupSendSnapshot{return {id,accountId:"owner",deviceId:"device",groupId,createdAt:time,content:"private",payload:{client_request_id:id,ciphertext:"cipher",sender_device_id:"device",e2ee_metadata:"{}",key_epoch:1},files:[],encryptedFiles:[],origin:origin?{id:origin,deviceId:"device"}:undefined}}
const plan=(items:PendingGroupSendSnapshot[],failed:Array<{groupId:string;id:string}>=[])=>planGroupSendRestore(items,failed,"owner","device",new Set(["group","safe","__proto__"]));
it("orders child attempts before their sources despite backward clocks and shuffled input",()=>{
 const source=snapshot("source",300),child=snapshot("child",200,"group","source"),leaf=snapshot("leaf",100,"group","child");
 const result=plan([source,leaf,child]);expect(result.groups.group.map(item=>item.id)).toEqual(["leaf","child","source"]);expect(result.blocked).toEqual([]);
 expect([source.id,child.id,leaf.id]).toEqual(["source","child","leaf"]);
});
it("waits for all sibling children and keeps stable time/id ordering",()=>{
 const result=plan([snapshot("source",0),snapshot("b",4,"group","source"),snapshot("a",4,"group","source"),snapshot("unrelated",1)]);
 expect(result.groups.group.map(item=>item.id)).toEqual(["unrelated","a","b","source"]);
});
it("orders reviewed children before every distinct file source and detects source cycles",()=>{
 const child=snapshot("child",100);child.origin={deviceId:"device",id:"a"};child.fileSources=[{fileIndex:0,deviceId:"device",id:"a",sourceIndex:0},{fileIndex:1,deviceId:"device",id:"b",sourceIndex:2}];
 expect(plan([snapshot("a",0),snapshot("b",1),child]).groups.group.map(item=>item.id)).toEqual(["child","a","b"]);
 const parent=snapshot("a");parent.fileSources=[{fileIndex:0,deviceId:"device",id:"child",sourceIndex:0}];expect(plan([parent,child,snapshot("b")]).blocked).toEqual([{groupId:"group",reason:"dependency_cycle"}]);
});
it("blocks an entire cyclic group without dropping or processing part of its records",()=>{
 const result=plan([snapshot("a",1,"group","b"),snapshot("b",2,"group","a"),snapshot("unrelated"),snapshot("safe-item",1,"safe")]);
 expect(result.groups.group).toBeUndefined();expect(result.blocked).toEqual([{groupId:"group",reason:"dependency_cycle"}]);expect(result.groups.safe[0].id).toBe("safe-item");
});
it("does not expose inaccessible group content or accept another account/device",()=>{
 const result=plan([snapshot("hidden",1,"inaccessible"),{...snapshot("wrong"),accountId:"other"},snapshot("safe-item",1,"safe")]);
 expect(result.unavailable).toEqual([{groupId:"inaccessible",id:"hidden"}]);expect(JSON.stringify(result.unavailable)).not.toContain("private");expect(result.groups.group).toBeUndefined();expect(result.blocked).toEqual([{groupId:"group",reason:"scope_mismatch"}]);
 const device=plan([{...snapshot("wrong"),deviceId:"other"}]);expect(device.blocked[0].reason).toBe("scope_mismatch");
});
it("blocks duplicate or unreadable records rather than choosing a convenient copy",()=>{
 expect(plan([snapshot("same"),snapshot("same")]).blocked).toEqual([{groupId:"group",reason:"duplicate_request"}]);
 const result=plan([snapshot("valid")],[{groupId:"group",id:"corrupt"}]);expect(result.groups.group).toBeUndefined();expect(result.blocked).toEqual([{groupId:"group",reason:"unreadable"}]);
});
it("allows already-removed or different-device sources and safely keys unusual group IDs",()=>{
 const child=snapshot("child",1,"group","absent");const other=snapshot("other",2);other.origin={id:"absent-other",deviceId:"old-device"};
 const result=plan([child,other,snapshot("special",1,"__proto__")]);expect(result.blocked).toEqual([]);expect(result.groups.group).toHaveLength(2);expect(result.groups.__proto__[0].id).toBe("special");expect(Object.getPrototypeOf(result.groups)).toBeNull();
});
