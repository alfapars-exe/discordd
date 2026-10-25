import {ManualVoiceSoundTracker} from "../../utils/voiceEventSounds";
import {bindNativePTT,nativePTTAvailable}from "../../audio/nativePTT";
import { useLayoutEffect, useState, useRef } from "react";
import type { Room } from "livekit-client";
import { useTranslation } from "react-i18next";
import {useGroupCallStore}from "../../stores/groupCallStore";
import {invalidateCaptureAdmission,captureAdmissionCurrent,subscribeCaptureAdmission}from "../../audio/microphoneAdmission";
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
export default function GroupDMCallAudio({room,microphoneEnabled,onMicrophoneChange,onCaptureState,captureFailure=false,onCaptureFailure,isCurrentSession,conflict}:{room:Room;microphoneEnabled:boolean;onMicrophoneChange:(enabled:boolean)=>void;onCaptureState?:(ready:boolean)=>void;captureFailure?:boolean;onCaptureFailure?:(failed:boolean)=>void;isCurrentSession?:()=>boolean;conflict:boolean}){
 const {t}=useTranslation("voice");
 const [ownerScope]=useState(()=>JSON.stringify(getAuthSessionSnapshot()));
 const activeRoom=useRef<Room|null>(null);
 const sessionCheck=useRef(isCurrentSession);useLayoutEffect(()=>{sessionCheck.current=isCurrentSession;});
 const inputMode=useVoiceStore(state=>state.inputMode);
 const deafened=useVoiceStore(state=>state.isDeafened);
 const soundCurrent=useRef<()=>boolean>(()=>false);
 const soundTracker=useRef<ManualVoiceSoundTracker|null>(null);
 const [nativeUnavailable,setNativeUnavailable]=useState(false);
 const [failure,setFailure]=useState(false),[outputStatus,setOutputStatus]=useState("ready"),[retry,setRetry]=useState(0);
 useLayoutEffect(()=>{
  activeRoom.current=room;
  const participant=room.localParticipant,controller=liveMicrophone(participant,"private");
  const unsubscribeStatus=controller.subscribe(()=>{const status=controller.getStatus();if(status.phase==="failed"){setFailure(true);onCaptureFailure?.(true);}onCaptureState?.(status.phase==="ready");});
  const auth=JSON.stringify(getAuthSessionSnapshot());let active=true,pressed=false,conflictLatched=privateCaptureConflict();
  let nativeStop=()=>{},nativeConfig="",nativeWorks=false;
  const current=()=>active&&sessionCheck.current?.()!==false&&JSON.stringify(getAuthSessionSnapshot())===auth;
  soundCurrent.current=current;
  if(soundTracker.current===null)soundTracker.current=new ManualVoiceSoundTracker({manualMuted:!microphoneEnabled,deafened:useVoiceStore.getState().isDeafened},()=>soundCurrent.current());
  const apply=()=>{
   if(!current())return;
   const state=useVoiceStore.getState();
   if(privateCaptureConflict())conflictLatched=true;
   const enabled=microphoneEnabled&&!captureFailure&&!conflictLatched&&!privateCaptureConflict()&&!state.isDeafened&&(state.inputMode!=="push_to_talk"||pressed);
   const manual={manualMuted:!microphoneEnabled,deafened:state.isDeafened};
   soundTracker.current?.observe(manual);
   void controller.setEnabled(enabled).then(()=>{
    if(current()&&!captureFailure&&!conflictLatched&&!privateCaptureConflict()){
      const phase=controller.getStatus().phase;
      if(phase==="ready"||phase==="idle")soundTracker.current?.commit(manual,phase==="ready");
      else if(phase==="failed")soundTracker.current?.reject();
    }
   }).catch(()=>{if(current()){soundTracker.current?.reject();setFailure(true);}});
  };
  const refreshNative=()=>{
   const state=useVoiceStore.getState(),desired=current()&&captureAdmissionCurrent(participant)&&nativePTTAvailable()&&state.inputMode==="push_to_talk"&&!useShortcutCaptureStore.getState().active&&!captureFailure&&!conflictLatched&&!privateCaptureConflict()&&!state.isDeafened&&microphoneEnabled;
   const config=desired?state.pttKey:"";if(config===nativeConfig)return;nativeStop();nativeConfig=config;nativeWorks=!!config;pressed=false;apply();
   if(config)nativeStop=bindNativePTT({kind:"group",source:crypto.randomUUID(),keyCode:config,current:()=>current()&&captureAdmissionCurrent(participant)&&!privateCaptureConflict()&&!conflictLatched&&microphoneEnabled&&!captureFailure&&!useVoiceStore.getState().isDeafened,onPressed:value=>{pressed=value;apply();},onUnavailable:()=>{if(current())setNativeUnavailable(true);}});
  };
  const admissionStop=subscribeCaptureAdmission(participant,()=>{nativeStop();nativeConfig="";pressed=false;apply();});
  const retire=()=>{if(!current()){nativeStop();void controller.setEnabled(false);void releaseLiveMicrophone(participant,controller);}};
  const unsubscribeOwner=subscribeAuthOwnerChanges(retire),unsubscribeGeneration=subscribeAuthGenerationChanges(retire);
  const unsubscribeVoice=useVoiceStore.subscribe((state,previous)=>{
   if(!settingsEqual(microphoneSettings(state),microphoneSettings(previous)))void controller.refresh().catch(()=>{if(current())setFailure(true);});
   refreshNative();
   if(state.isDeafened||privateCaptureConflict()||state.inputMode!==previous.inputMode||state.pttKey!==previous.pttKey)pressed=false;
   if(state.isDeafened!==previous.isDeafened||state.inputMode!==previous.inputMode||state.pttKey!==previous.pttKey||state.currentVoiceChannelId!==previous.currentVoiceChannelId)apply();
  });
  const unsubscribeSession=useGroupCallStore.subscribe(()=>{if(sessionCheck.current?.()===false){invalidateCaptureAdmission(participant);nativeStop();void controller.setEnabled(false);void releaseLiveMicrophone(participant,controller);}});
  const unsubscribeCall=useP2PCallStore.subscribe(()=>{if(privateCaptureConflict())pressed=false;refreshNative();apply();});
  const editable=(element:Element|null)=>element?.tagName==="INPUT"||element?.tagName==="TEXTAREA"||element?.tagName==="SELECT"||!!(element as HTMLElement|null)?.isContentEditable;
  const down=(event:KeyboardEvent)=>{
   const state=useVoiceStore.getState(),element=document.activeElement;
   if(nativeWorks||!current()||!document.hasFocus()||document.visibilityState==="hidden"||state.inputMode!=="push_to_talk"||event.code!==state.pttKey||event.repeat||event.defaultPrevented||event.isComposing||useShortcutCaptureStore.getState().active)return;
   if(editable(element))return;
   if(conflictLatched||privateCaptureConflict()||state.isDeafened||!microphoneEnabled)return;
   pressed=true;apply();
  };
  const release=()=>{if(nativeWorks)return;pressed=false;apply();};
  const up=(event:KeyboardEvent)=>{if(event.code===useVoiceStore.getState().pttKey)release();};
  const visibility=()=>{if(document.visibilityState==="hidden")release();};
  const focus=(event:FocusEvent)=>{if(editable(event.target instanceof Element?event.target:null))release();};
  document.addEventListener("visibilitychange",visibility);document.addEventListener("focusin",focus);
  document.addEventListener("keydown",down);document.addEventListener("keyup",up);window.addEventListener("blur",release);
  const unsubscribeCapture=useShortcutCaptureStore.subscribe(state=>{if(state.active){nativeStop();nativeConfig="";pressed=false;apply();}else refreshNative();});
  refreshNative();apply();
  return()=>{nativeStop();admissionStop();if(activeRoom.current===room)activeRoom.current=null;active=false;unsubscribeStatus();onCaptureState?.(false);unsubscribeOwner();unsubscribeGeneration();unsubscribeVoice();unsubscribeCall();unsubscribeSession();unsubscribeCapture();document.removeEventListener("visibilitychange",visibility);document.removeEventListener("focusin",focus);document.removeEventListener("keydown",down);document.removeEventListener("keyup",up);window.removeEventListener("blur",release);void controller.setEnabled(false);void releaseLiveMicrophone(participant,controller);};
 },[room,microphoneEnabled,retry,onCaptureState,captureFailure,onCaptureFailure]);
 useLayoutEffect(()=>{const stop=privateRoomPlayback(room,setOutputStatus,()=>sessionCheck.current?.()!==false);const unsubscribe=useGroupCallStore.subscribe(()=>{if(sessionCheck.current?.()===false)stop();});return()=>{unsubscribe();stop();};},[room,retry]);
 return <>
  <button type="button" disabled={conflict} aria-pressed={microphoneEnabled&&!deafened&&!conflict} onClick={()=>onMicrophoneChange(!microphoneEnabled)}>{t(microphoneEnabled?"mute":"unmute")}</button>
  {conflict&&<p role="status">{t("groupCaptureConflict")}</p>}
  {inputMode==="push_to_talk"&&!nativePTTAvailable()&&<p role="status">{t("groupFocusedPTT")}</p>}
  {nativeUnavailable&&inputMode==="push_to_talk"&&<p role="alert">{t("backgroundPTTUnavailable")}</p>}
  {(failure||captureFailure)&&<p role="alert">{t("microphoneCaptureStopped")}</p>}
  {outputStatus!=="ready"&&<p role={outputStatus==="failed"?"alert":"status"}>{t(outputStatus==="failed"?"p2pAudioFailed":"p2pAudioFallback")}</p>}
  {(failure||captureFailure)&&<button type="button" onClick={()=>{if(activeRoom.current!==room||!captureAdmissionCurrent(room.localParticipant)||sessionCheck.current?.()===false||JSON.stringify(getAuthSessionSnapshot())!==ownerScope)return;useVoiceStore.getState().setInputDevice("");onCaptureFailure?.(false);setFailure(false);setNativeUnavailable(false);setRetry(value=>value+1);}}>{t("microphoneUseDefault")}</button>}
  {(nativeUnavailable||failure||captureFailure||outputStatus==="failed")&&<button type="button" onClick={()=>{if(activeRoom.current!==room||!captureAdmissionCurrent(room.localParticipant)||sessionCheck.current?.()===false||JSON.stringify(getAuthSessionSnapshot())!==ownerScope)return;onCaptureFailure?.(false);setFailure(false);setNativeUnavailable(false);setRetry(value=>value+1);}}>{t("p2pAudioRetry")}</button>}
 </>;
}
