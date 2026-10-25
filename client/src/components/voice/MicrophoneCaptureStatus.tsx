import {useSyncExternalStore,useLayoutEffect,useState}from "react";
import type{LocalParticipant}from "livekit-client";
import {useTranslation}from "react-i18next";
import {getAuthSessionSnapshot}from "../../api/authSessionEvents";
import {isMicrophoneCaptureViewCurrent,activateMicrophoneCaptureView,bindMicrophoneCaptureView,releaseMicrophoneCaptureView}from "../../stores/microphoneCaptureViewStore";
import {liveMicrophone}from "../../audio/liveMicrophone";
import {useVoiceStore}from "../../stores/voiceStore";
/** Failure is independent from manual intent: retry never secretly unmutes. */
export default function MicrophoneCaptureStatus({participant}:{participant:LocalParticipant}){
 const {t}=useTranslation("voice");const controller=liveMicrophone(participant);
 const status=useSyncExternalStore(controller.subscribe,controller.getStatus,controller.getStatus);
 const [binding]=useState(()=>({auth:getAuthSessionSnapshot(),channelId:useVoiceStore.getState().currentVoiceChannelId,joinGeneration:useVoiceStore.getState()._joinGeneration??0,nonce:crypto.randomUUID(),initialFailure:status.phase==="failed"}));
 useLayoutEffect(()=>{if(binding.auth.ownerId&&binding.channelId)activateMicrophoneCaptureView({nonce:binding.nonce,owner:binding.auth.ownerId,generation:binding.auth.generation,channelId:binding.channelId,joinGeneration:binding.joinGeneration,failed:binding.initialFailure});return()=>releaseMicrophoneCaptureView(binding.nonce);},[binding]);
 useLayoutEffect(()=>{if(binding.auth.ownerId&&binding.channelId&&useVoiceStore.getState().currentVoiceChannelId===binding.channelId)bindMicrophoneCaptureView({nonce:binding.nonce,owner:binding.auth.ownerId,generation:binding.auth.generation,channelId:binding.channelId,joinGeneration:binding.joinGeneration,failed:status.phase==="failed"});},[binding,status.phase]);
 if(status.phase!=="failed")return null;
 const retry=(useDefault:boolean)=>{if(!isMicrophoneCaptureViewCurrent(binding.nonce)||!controller.canRecover())return;const voice=useVoiceStore.getState();if(useDefault)voice.setInputDevice("");const current=useVoiceStore.getState();void controller.retry(current.inputMode!=="push_to_talk"&&!current.isMuted&&!current.isServerMuted&&!current.isDeafened&&!current.isServerDeafened).catch(()=>{});};
 return <div role="alert"><p>{t("microphoneCaptureStopped")}</p><button type="button" onClick={()=>retry(false)}>{t("microphoneCaptureRetry")}</button><button type="button" onClick={()=>retry(true)}>{t("microphoneUseDefault")}</button></div>;
}
