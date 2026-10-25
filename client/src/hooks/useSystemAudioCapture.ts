import i18n from "../i18n";
import {useToastStore}from "../stores/toastStore";
import {useCallback,useEffect,useRef,useState}from "react";
import type{LocalParticipant}from "livekit-client";
import {useVoiceStore}from "../stores/voiceStore";
import {captureAdmissionCurrent,subscribeCaptureAdmission}from "../audio/microphoneAdmission";
import {SystemAudioCaptureSession}from "../audio/systemAudioCaptureSession";
import {isElectron}from "../utils/constants";
/** Guild adapter over the same exact-owned PCM pipeline used by private shares. */
export function useSystemAudioCapture(participant?:LocalParticipant){
 const[isCapturing,setIsCapturing]=useState(false);const owner=useRef<SystemAudioCaptureSession|null>(null);
 const stop=useCallback(()=>{const current=owner.current;owner.current=null;current?.stop();setIsCapturing(false);},[]);
 useEffect(()=>()=>{const old=owner.current;owner.current=null;old?.stop();},[]);
 const start=useCallback(async(currentSource?:()=>boolean):Promise<MediaStreamTrack|null>=>{
  stop();if(!isElectron())return null;
  const channel=useVoiceStore.getState().currentVoiceChannelId,join=useVoiceStore.getState()._joinGeneration;
  const current=()=>{const voice=useVoiceStore.getState();return voice.currentVoiceChannelId===channel&&voice._joinGeneration===join&&(!currentSource||currentSource())&&(!participant||(voice.isStreaming&&captureAdmissionCurrent(participant)));};
  let capture:SystemAudioCaptureSession|null=null;
  capture=new SystemAudioCaptureSession({kind:"guild",source:crypto.randomUUID(),current,
   subscribeCurrent:retire=>{const off=useVoiceStore.subscribe(retire),admission=participant?subscribeCaptureAdmission(participant,retire):()=>{};return()=>{off();admission();};},state:status=>{if(capture&&owner.current===capture){setIsCapturing(status.phase==="ready");if(status.phase==="failed"&&current())useToastStore.getState().addToast("error",i18n.t("voice:privateScreenAudioUnavailable"));}}});
  owner.current=capture;try{return await capture.start();}catch{return null;}
 },[participant,stop]);
 return{start,stop,isCapturing};
}
