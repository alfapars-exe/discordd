import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { registerGameNameIPC } from "./registered-game-name-ipc";
test("name IPC rejects foreign sender and invalid bounded values before touching local registry",async()=>{
 let handler!: (event:IpcMainInvokeEvent,...args:unknown[])=>unknown;const event={} as IpcMainInvokeEvent;const calls:unknown[]=[];
 registerGameNameIPC({handle:(_name,callback)=>{handler=callback}} as Pick<IpcMain,"handle">,value=>{if(value!==event)throw new Error("Untrusted sender")},{setDisplayName:async(id,name)=>{calls.push([id,name]);return true}});
 const id="12345678-1234-1234-1234-123456789012";assert.throws(()=>handler({} as IpcMainInvokeEvent,id,"Name"),/Untrusted/);
 for(const bad of [null,{},"", "a".repeat(81),"bad\nname","C:\\Games\\game.exe"])assert.throws(()=>handler(event,id,bad),TypeError);
 for(const bad of [null,"other", "a".repeat(65)])assert.throws(()=>handler(event,bad,"Name"),TypeError);
 assert.equal(calls.length,0);assert.equal(await handler(event,id,"  My Game  "),true);assert.deepEqual(calls,[[id,"My Game"]]);
});
