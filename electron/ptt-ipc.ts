import type {IpcMain,IpcMainInvokeEvent,WebContents}from "electron";
import {validPTTRequest,type PTTRequest}from "./ptt-leases";
/** Only the application top-level renderer may acquire bounded native leases. */
export function registerPTTLeaseHandlers(ipc:Pick<IpcMain,"handle">,trusted:(event:IpcMainInvokeEvent)=>void,owner:{acquire:(sender:number,request:PTTRequest)=>string|null;release:(sender:number,id:string)=>void;retire:(sender:number)=>void}){
 const senders=new WeakSet<WebContents>();
 ipc.handle("acquire-ptt-lease",(event,request:unknown)=>{
  trusted(event);if(!validPTTRequest(request))throw new Error("Invalid PTT lease.");
  if(!senders.has(event.sender)){
   senders.add(event.sender);const id=event.sender.id;
   event.sender.on("destroyed",()=>owner.retire(id));
   event.sender.on("render-process-gone",()=>owner.retire(id));
   event.sender.on("did-start-navigation",(_event,_url,isInPlace,isMainFrame)=>{if(isMainFrame&&!isInPlace)owner.retire(id);});
  }
  return owner.acquire(event.sender.id,request);
 });
 ipc.handle("release-ptt-lease",(event,id:unknown)=>{
  trusted(event);if(typeof id!=="string"||!id.length||id.length>80)throw new Error("Invalid PTT lease.");owner.release(event.sender.id,id);
 });
}
