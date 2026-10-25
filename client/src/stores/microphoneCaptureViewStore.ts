import {useVoiceStore}from "./voiceStore";
import {create}from "zustand";
import {getAuthSessionSnapshot,subscribeAuthGenerationChanges,subscribeAuthOwnerChanges}from "../api/authSessionEvents";
export type GuildCaptureCall={owner:string;generation:number;channelId:string;joinGeneration:number};
type View={nonce:string;owner:string;generation:number;channelId:string;joinGeneration:number;failed:boolean};
export const useMicrophoneCaptureViewStore=create<{view:View|null;failedCall:GuildCaptureCall|null;privateFailure:{nonce:string;owner:string;generation:number}|null}>(()=>({view:null,failedCall:null,privateFailure:null}));
const current=(view:View)=>{const auth=getAuthSessionSnapshot();const voice=useVoiceStore.getState();return auth.ownerId===view.owner&&auth.generation===view.generation&&voice.currentVoiceChannelId===view.channelId&&(voice._joinGeneration??0)===view.joinGeneration;};
export function activateMicrophoneCaptureView(view:View){if(current(view))useMicrophoneCaptureViewStore.setState({view});}
export function bindMicrophoneCaptureView(view:View){if(current(view)&&useMicrophoneCaptureViewStore.getState().view?.nonce===view.nonce)useMicrophoneCaptureViewStore.setState({view});}
export function releaseMicrophoneCaptureView(nonce:string){if(useMicrophoneCaptureViewStore.getState().view?.nonce===nonce)useMicrophoneCaptureViewStore.setState({view:null});}
const retire=()=>{const privateFailure=useMicrophoneCaptureViewStore.getState().privateFailure,liveAuth=getAuthSessionSnapshot();if(privateFailure&&(privateFailure.owner!==liveAuth.ownerId||privateFailure.generation!==liveAuth.generation))useMicrophoneCaptureViewStore.setState({privateFailure:null});const failed=useMicrophoneCaptureViewStore.getState().failedCall,auth=getAuthSessionSnapshot();if(failed&&(failed.owner!==auth.ownerId||failed.generation!==auth.generation))useMicrophoneCaptureViewStore.setState({failedCall:null});const view=useMicrophoneCaptureViewStore.getState().view;if(view&&!current(view))useMicrophoneCaptureViewStore.setState({view:null});};
subscribeAuthOwnerChanges(retire);subscribeAuthGenerationChanges(retire);

export function isMicrophoneCaptureViewCurrent(nonce:string){const view=useMicrophoneCaptureViewStore.getState().view;return !!view&&view.nonce===nonce&&current(view);}

const callCurrent=(call:GuildCaptureCall)=>{const auth=getAuthSessionSnapshot(),voice=useVoiceStore.getState();return auth.ownerId===call.owner&&auth.generation===call.generation&&voice.currentVoiceChannelId===call.channelId&&(voice._joinGeneration??0)===call.joinGeneration;};
export function hasGuildCaptureFailure(call:GuildCaptureCall){const failed=useMicrophoneCaptureViewStore.getState().failedCall;return !!failed&&callCurrent(call)&&failed.owner===call.owner&&failed.generation===call.generation&&failed.channelId===call.channelId&&failed.joinGeneration===call.joinGeneration;}
export function latchGuildCaptureFailure(call:GuildCaptureCall){if(callCurrent(call))useMicrophoneCaptureViewStore.setState({failedCall:call});}
export function clearGuildCaptureFailure(call:GuildCaptureCall){if(hasGuildCaptureFailure(call))useMicrophoneCaptureViewStore.setState({failedCall:null});}

export function latchPrivateCaptureFailure(nonce:string,owner:string,generation:number){const auth=getAuthSessionSnapshot();if(auth.ownerId===owner&&auth.generation===generation)useMicrophoneCaptureViewStore.setState({privateFailure:{nonce,owner,generation}});}
export function clearPrivateCaptureFailure(nonce:string){const failure=useMicrophoneCaptureViewStore.getState().privateFailure,auth=getAuthSessionSnapshot();if(failure?.nonce===nonce&&failure.owner===auth.ownerId&&failure.generation===auth.generation)useMicrophoneCaptureViewStore.setState({privateFailure:null});}
export function retirePrivateCaptureFailure(nonce:string){if(useMicrophoneCaptureViewStore.getState().privateFailure?.nonce===nonce)useMicrophoneCaptureViewStore.setState({privateFailure:null});}
