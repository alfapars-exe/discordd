import {useLayoutEffect,useRef,useState}from "react";
import type {Room}from "livekit-client";
import {OwnedCamera,type CameraStatus}from "../audio/ownedCamera";
/** Shared guild/private camera, mounted inside an admitted Room only. */
export function useRoomCamera(room:Room,enabled:boolean,admitted:boolean,currentSource?:()=>boolean,onFailure?:()=>void,subscribeSource?:(retire:()=>void)=>()=>void){
 const [status,setStatus]=useState<CameraStatus>({phase:"idle"});
 const latest=useRef({enabled,currentSource,onFailure});useLayoutEffect(()=>{latest.current={enabled,currentSource,onFailure};});
 const controller=useRef<OwnedCamera|null>(null);
 useLayoutEffect(()=>{
  if(!admitted)return;
  let active=true;const source=latest.current.currentSource;const owner=new OwnedCamera(room.localParticipant,()=>active&&source?.()!==false,value=>{if(active)setStatus(value);},()=>{if(active)latest.current.onFailure?.();},subscribeSource);controller.current=owner;void owner.setEnabled(latest.current.enabled);
  return()=>{active=false;if(controller.current===owner)controller.current=null;owner.dispose();};
 },[room,admitted,subscribeSource]);
 useLayoutEffect(()=>{void controller.current?.setEnabled(enabled);},[enabled,room,admitted]);
 return {...status,retry:(enable:()=>void)=>{if(controller.current?.canRetry(status))enable();}};
}
