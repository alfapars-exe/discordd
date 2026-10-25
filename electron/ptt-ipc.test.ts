import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter}from "node:events";
import type {IpcMain,IpcMainInvokeEvent}from "electron";
import {registerPTTLeaseHandlers}from "./ptt-ipc.js";
test("trusted bounded PTT handlers reject subframes/foreign senders and retire only actual sender",()=>{
 const handlers=new Map<string,(event:IpcMainInvokeEvent,arg:unknown)=>unknown>(),calls:unknown[][]=[];
 const sender=Object.assign(new EventEmitter(),{id:9});const event={sender,senderFrame:{trusted:true}}as unknown as IpcMainInvokeEvent;
 registerPTTLeaseHandlers({handle:(channel,callback)=>{handlers.set(channel,callback);}}as Pick<IpcMain,"handle">,e=>{if(e!==event)throw new Error("Untrusted IPC sender.");},{acquire:(id,req)=>{calls.push(["acquire",id,req]);return"lease";},release:(id,key)=>calls.push(["release",id,key]),retire:id=>calls.push(["retire",id])});
 const acquire=handlers.get("acquire-ptt-lease")!,release=handlers.get("release-ptt-lease")!;
 const request={kind:"group",source:"nonce",keyCode:"Space"};
 assert.throws(()=>acquire({...event}as IpcMainInvokeEvent,request),/Untrusted/);assert.throws(()=>acquire(event,{...request,source:"x".repeat(161)}),/Invalid/);assert.equal(calls.length,0);
 assert.equal(acquire(event,request),"lease");acquire(event,request);assert.equal(sender.listenerCount("destroyed"),1);
 assert.throws(()=>release({...event}as IpcMainInvokeEvent,"lease"),/Untrusted/);assert.throws(()=>release(event,"x".repeat(81)),/Invalid/);release(event,"lease");
 sender.emit("did-start-navigation",{},"",false,false);sender.emit("did-start-navigation",{},"app://hichat/#settings",true,true);assert.equal(calls.length,3);sender.emit("did-start-navigation",{},"",false,true);sender.emit("render-process-gone");sender.emit("destroyed");
 assert.deepEqual(calls.slice(-3),[["retire",9],["retire",9],["retire",9]]);
});
