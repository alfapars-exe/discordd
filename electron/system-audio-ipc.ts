import type{IpcMain,IpcMainInvokeEvent,WebContents}from "electron";
import type{CaptureLeaseRequest}from "./audio-capture";
export function registerSystemAudioLeaseIPC(ipc:Pick<IpcMain,"handle">,trusted:(event:IpcMainInvokeEvent)=>void,worker:{reserve:(sender:number,request:CaptureLeaseRequest)=>string;start:(sender:number,id:string)=>Promise<void>;release:(sender:number,id:string)=>boolean;retire:(sender:number)=>void}){
 const seen=new WeakSet<WebContents>();
 const leaseID=(value:unknown)=>{if(typeof value!=="string"||value.length<1||value.length>80)throw new Error("Invalid capture lease.");return value;};
 ipc.handle("reserve-system-capture-lease",(event,value:unknown)=>{
  trusted(event);if(!value||typeof value!=="object")throw new Error("Invalid capture source.");const v=value as Partial<CaptureLeaseRequest>;
  if(!["guild","p2p","group"].includes(v.kind??"")||typeof v.source!=="string"||v.source.length<1||v.source.length>160)throw new Error("Invalid capture source.");
  if(!seen.has(event.sender)){seen.add(event.sender);const id=event.sender.id;event.sender.on("destroyed",()=>worker.retire(id));event.sender.on("render-process-gone",()=>worker.retire(id));event.sender.on("did-start-navigation",(_event,_url,isInPlace,main)=>{if(main&&!isInPlace)worker.retire(id);});}
  return worker.reserve(event.sender.id,v as CaptureLeaseRequest);
 });
 ipc.handle("start-system-capture-lease",(event,id:unknown)=>{trusted(event);return worker.start(event.sender.id,leaseID(id));});
 ipc.handle("release-system-capture-lease",(event,id:unknown)=>{trusted(event);return worker.release(event.sender.id,leaseID(id));});
}
