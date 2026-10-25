import {useState}from "react";
import {useTranslation}from "react-i18next";
import type{Room}from "livekit-client";
import {useRoomCamera}from "../../hooks/useRoomCamera";
import {useGroupCallStore}from "../../stores/groupCallStore";
import CameraCaptureStatus from "../voice/CameraCaptureStatus";
const subscribeSource=(retire:()=>void)=>useGroupCallStore.subscribe(retire);
export default function GroupDMCallCamera({room,admitted,current}:{room:Room;admitted:boolean;current?:()=>boolean}){
 const{t}=useTranslation("voice");const[enabled,setEnabled]=useState(false);
 const camera=useRoomCamera(room,enabled,admitted,current,()=>setEnabled(false),subscribeSource);
 if(!admitted)return null;
 return <><button type="button" disabled={!admitted} aria-pressed={admitted&&camera.phase==="active"} onClick={()=>setEnabled(value=>!value)}>{t("camera")}</button><CameraCaptureStatus status={camera} retry={()=>{if(admitted&&current?.()!==false)camera.retry(()=>setEnabled(true));}}/></>;
}
