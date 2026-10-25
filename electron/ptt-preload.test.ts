import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter}from "node:events";
import {readFileSync}from "node:fs";
import path from "node:path";
import vm from "node:vm";
test("scoped preload unsubscribe and legacy removeAll cannot delete another leased listener",()=>{
 const ipc=Object.assign(new EventEmitter(),{invoke:async(...args:unknown[])=>args});let api!: {onPTTLeaseSignal:(cb:(value:unknown)=>void)=>()=>void;removePTTListeners:()=>void;acquirePTTLease:(value:unknown)=>Promise<unknown>;releasePTTLease:(id:string)=>Promise<unknown>};
 vm.runInNewContext(readFileSync(path.join(__dirname,"preload.js"),"utf8"),{exports:{},require:(name:string)=>{if(name!=="electron")throw new Error(name);return{ipcRenderer:ipc,contextBridge:{exposeInMainWorld:(_key:string,value:typeof api)=>{api=value;}}};}});
 const events:unknown[]=[];const first=api.onPTTLeaseSignal(v=>events.push([1,v]));api.onPTTLeaseSignal(v=>events.push([2,v]));api.removePTTListeners();first();first();ipc.emit("ptt-lease-signal",{}, {leaseId:"second",pressed:true});
 assert.equal(events.length,1);assert.equal(ipc.listenerCount("ptt-lease-signal"),1);
});
