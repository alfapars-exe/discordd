import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter}from "node:events";
import {readFileSync}from "node:fs";
import path from "node:path";
import vm from "node:vm";
test("capture lease subscription cleanup never removes guild/private siblings or legacy listeners",()=>{
 const ipc=Object.assign(new EventEmitter(),{invoke:async(...args:unknown[])=>args});let api!:{onSystemCaptureLeaseEvent:(cb:(event:unknown)=>void)=>()=>void;removeCaptureListeners:()=>void};vm.runInNewContext(readFileSync(path.join(__dirname,"preload.js"),"utf8"),{exports:{},require:(name:string)=>{if(name!=="electron")throw new Error(name);return{ipcRenderer:ipc,contextBridge:{exposeInMainWorld:(_name:string,value:typeof api)=>{api=value;}}};}});
 const events:unknown[]=[];const first=api.onSystemCaptureLeaseEvent(value=>events.push([1,value]));api.onSystemCaptureLeaseEvent(value=>events.push([2,value]));api.removeCaptureListeners();first();first();ipc.emit("system-capture-lease-event",{}, {leaseId:"remaining",type:"header",value:{}});assert.equal(events.length,1);assert.equal(ipc.listenerCount("system-capture-lease-event"),1);
});
