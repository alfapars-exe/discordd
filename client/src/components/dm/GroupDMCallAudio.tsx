import { useLayoutEffect, useState } from "react";
import type { Room } from "livekit-client";
import { useTranslation } from "react-i18next";
import { liveMicrophone, releaseLiveMicrophone } from "../../audio/liveMicrophone";
import { microphoneSettings, settingsEqual } from "../../audio/microphoneSettings";
import { privateCaptureConflict } from "../../audio/privateCallState";
import { privateRoomPlayback } from "../../audio/privateRoomPlayback";
import { useVoiceStore } from "../../stores/voiceStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useShortcutCaptureStore } from "../../stores/shortcutCaptureStore";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../../api/authSessionEvents";

/** Mounted only after encrypted admission. Capture is owned by the actual
 * shared processor controller; private mute intent never toggles another call. */
export default function GroupDMCallAudio({room,microphoneEnabled,onMicrophoneChange,conflict}:{room:Room;microphoneEnabled:boolean;onMicrophoneChange:(enabled:boolean)=>void;conflict:boolean}){
 const {t}=useTranslation("voice");
 const inputMode=useVoiceStore(state=>state.inputMode);
 const deafened=useVoiceStore(state=>state.isDeafened);
 const [failure,setFailure]=useState(false),[outputStatus,setOutputStatus]=useState("ready"),[retry,setRetry]=useState(0);
 useLayoutEffect(()=>{
  const participant=room.localParticipant,controller=liveMicrophone(participant,"private");
  const auth=JSON.stringify(getAuthSessionSnapshot());let active=true,pressed=false,conflictLatched=privateCaptureConflict();
  const current=()=>active&&JSON.stringify(getAuthSessionSnapshot())===auth;
  const apply=()=>{
   if(!current())return;
   const state=useVoiceStore.getState();
   if(privateCaptureConflict())conflictLatched=true;
   const enabled=microphoneEnabled&&!conflictLatched&&!privateCaptureConflict()&&!state.isDeafened&&(state.inputMode!=="push_to_talk"||pressed);
   void controller.setEnabled(enabled).catch(()=>{if(current())setFailure(true);});
  };
  const retire=()=>{if(!current()){void controller.setEnabled(false);void releaseLiveMicrophone(participant);}};
  const unsubscribeOwner=subscribeAuthOwnerChanges(retire),unsubscribeGeneration=subscribeAuthGenerationChanges(retire);
  const unsubscribeVoice=useVoiceStore.subscribe((state,previous)=>{
   if(!settingsEqual(microphoneSettings(state),microphoneSettings(previous)))void controller.refresh().catch(()=>{if(current())setFailure(true);});
   if(state.isDeafened||privateCaptureConflict()||state.inputMode!==previous.inputMode||state.pttKey!==previous.pttKey)pressed=false;
   if(state.isDeafened!==previous.isDeafened||state.inputMode!==previous.inputMode||state.pttKey!==previous.pttKey||state.currentVoiceChannelId!==previous.currentVoiceChannelId)apply();
  });
  const unsubscribeCall=useP2PCallStore.subscribe(()=>{if(privateCaptureConflict())pressed=false;apply();});
  const editable=(element:Element|null)=>element?.tagName==="INPUT"||element?.tagName==="TEXTAREA"||element?.tagName==="SELECT"||!!(element as HTMLElement|null)?.isContentEditable;
  const down=(event:KeyboardEvent)=>{
   const state=useVoiceStore.getState(),element=document.activeElement;
   if(!current()||!document.hasFocus()||document.visibilityState==="hidden"||state.inputMode!=="push_to_talk"||event.code!==state.pttKey||event.repeat||event.defaultPrevented||event.isComposing||useShortcutCaptureStore.getState().active)return;
   if(editable(element))return;
   if(conflictLatched||privateCaptureConflict()||state.isDeafened||!microphoneEnabled)return;
   pressed=true;apply();
  };
  const release=()=>{pressed=false;apply();};
  const up=(event:KeyboardEvent)=>{if(event.code===useVoiceStore.getState().pttKey)release();};
  const visibility=()=>{if(document.visibilityState==="hidden")release();};
  const focus=(event:FocusEvent)=>{if(editable(event.target instanceof Element?event.target:null))release();};
  document.addEventListener("visibilitychange",visibility);document.addEventListener("focusin",focus);
  document.addEventListener("keydown",down);document.addEventListener("keyup",up);window.addEventListener("blur",release);
  const unsubscribeCapture=useShortcutCaptureStore.subscribe(state=>{if(state.active)release();});
  apply();
  return()=>{active=false;unsubscribeOwner();unsubscribeGeneration();unsubscribeVoice();unsubscribeCall();unsubscribeCapture();document.removeEventListener("visibilitychange",visibility);document.removeEventListener("focusin",focus);document.removeEventListener("keydown",down);document.removeEventListener("keyup",up);window.removeEventListener("blur",release);void controller.setEnabled(false);void releaseLiveMicrophone(participant);};
 },[room,microphoneEnabled,retry]);
 useLayoutEffect(()=>privateRoomPlayback(room,setOutputStatus),[room,retry]);
 return <>
  <button type="button" disabled={conflict} aria-pressed={microphoneEnabled&&!deafened&&!conflict} onClick={()=>onMicrophoneChange(!microphoneEnabled)}>{t(microphoneEnabled?"mute":"unmute")}</button>
  {conflict&&<p role="status">{t("groupCaptureConflict")}</p>}
  {inputMode==="push_to_talk"&&<p role="status">{t("groupFocusedPTT")}</p>}
  {failure&&<p role="alert">{t("groupMicrophoneFailed")}</p>}
  {outputStatus!=="ready"&&<p role={outputStatus==="failed"?"alert":"status"}>{t(outputStatus==="failed"?"p2pAudioFailed":"p2pAudioFallback")}</p>}
  {(failure||outputStatus==="failed")&&<button type="button" onClick={()=>{setFailure(false);setRetry(value=>value+1);}}>{t("p2pAudioRetry")}</button>}
 </>;
}
