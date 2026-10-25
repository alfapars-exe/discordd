import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter}from "node:events";
import type{IpcMain,IpcMainInvokeEvent}from "electron";
import {registerSystemAudioLeaseIPC}from "./system-audio-ipc.js";
test("capture IPC trusts only main frame and binds reserve/start/release to actual sender",async()=>{
 const callbacks=new Map<string,(event:IpcMainInvokeEvent,arg:unknown)=>unknown>(),calls:unknown[][]=[],sender=Object.assign(new EventEmitter(),{id:9}),event={sender}as unknown as IpcMainInvokeEvent;
 registerSystemAudioLeaseIPC({handle:(channel,callback)=>{callbacks.set(channel,callback);}}as Pick<IpcMain,"handle">,e=>{if(e!==event)throw new Error("Untrusted IPC sender.");},{reserve:(id,request)=>{calls.push(["reserve",id,request]);return"lease";},start:async(id,lease)=>{calls.push(["start",id,lease]);},release:(id,lease)=>{calls.push(["release",id,lease]);return true;},retire:id=>calls.push(["retire",id])});
 const reserve=callbacks.get("reserve-system-capture-lease")!,start=callbacks.get("start-system-capture-lease")!,release=callbacks.get("release-system-capture-lease")!,request={kind:"group",source:"opaque"};assert.throws(()=>reserve({...event}as IpcMainInvokeEvent,request),/Untrusted/);for(const value of [null,{}, {...request,kind:"other"},{...request,source:"x".repeat(161)}])assert.throws(()=>reserve(event,value),/Invalid/);assert.equal(calls.length,0);
 assert.equal(reserve(event,request),"lease");reserve(event,request);assert.equal(sender.listenerCount("destroyed"),1);assert.throws(()=>start(event,"x".repeat(81)),/Invalid/);await start(event,"lease");release(event,"lease");assert.deepEqual(calls.slice(-2),[["start",9,"lease"],["release",9,"lease"]]);const before=calls.length;sender.emit("did-start-navigation",{},"",false,false);sender.emit("did-start-navigation",{},"app://hichat/#settings",true,true);assert.equal(calls.length,before);sender.emit("did-start-navigation",{},"",false,true);sender.emit("render-process-gone");sender.emit("destroyed");assert.equal(calls.length,before+3);
});
