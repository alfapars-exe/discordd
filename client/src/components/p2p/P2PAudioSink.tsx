/** Independent exact-source remote playback owners, mounted outside the main chat. */
import {useEffect,useState,useSyncExternalStore} from "react";
import {useTranslation} from "react-i18next";
import {useP2PCallStore} from "../../stores/p2pCallStore";
import {useVoiceStore} from "../../stores/voiceStore";
import {useAuthStore} from "../../stores/authStore";
import {getAuthSessionSnapshot,subscribeAuthGenerationChanges,subscribeAuthOwnerChanges} from "../../api/authSessionEvents";
import {playPrivateAudio} from "../../audio/privatePlayback";
type Source="microphone"|"screen";
type Binding={owner:string;generation:number;callId:string;peer:string;connection:RTCPeerConnection;source:Source};
const streamOwners=new WeakMap<MediaStream,Binding>(),trackOwners=new WeakMap<MediaStreamTrack,Binding>();
const subscribeSession=(changed:()=>void)=>{const a=subscribeAuthGenerationChanges(changed),b=subscribeAuthOwnerChanges(changed);return()=>{a();b();};};
const bounded=(value:number,max:number)=>Number.isFinite(value)?Math.max(0,Math.min(max,value)):0;
function volume(peer:string,source:Source){const state=useVoiceStore.getState();if(state.isDeafened||state.localMutedUsers[peer])return 0;return bounded(state.masterVolume,100)/100*bounded((source==="screen"?state.screenShareVolumes:state.userVolumes)[peer]??100,200)/100;}
const selected=(source:Source)=>source==="screen"?useP2PCallStore.getState().remoteScreenAudioStream:useP2PCallStore.getState().remoteMicrophoneStream;
const same=(a:Binding,b:Binding)=>a.owner===b.owner&&a.generation===b.generation&&a.callId===b.callId&&a.peer===b.peer&&a.connection===b.connection&&a.source===b.source;
function SourceSink({source}:{source:Source}){
 const {t}=useTranslation("voice"),user=useAuthStore(s=>s.user?.id),generation=useSyncExternalStore(subscribeSession,()=>getAuthSessionSnapshot().generation,()=>getAuthSessionSnapshot().generation);
 const call=useP2PCallStore(s=>s.activeCall),connection=useP2PCallStore(s=>s.peerConnection),stream=useP2PCallStore(s=>source==="screen"?s.remoteScreenAudioStream:s.remoteMicrophoneStream),output=useVoiceStore(s=>s.outputDevice);
 const[revision,bump]=useState(0),[retry,setRetry]=useState(0),[status,setStatus]=useState<{key:string;stream:MediaStream;connection:RTCPeerConnection;failed:boolean}|null>(null);
 const key=JSON.stringify([source,user,generation,call?.id,call?.caller_id,call?.receiver_id,call?.status,output,revision,retry]);
 useEffect(()=>{
  if(!user||getAuthSessionSnapshot().ownerId!==user||!stream||!connection||!call||call.status!=="active"||![call.caller_id,call.receiver_id].includes(user))return;
  const tracks=stream.getAudioTracks().filter(track=>track.readyState!=="ended");
  const peer=call.caller_id===user?call.receiver_id:call.caller_id,binding:Binding={owner:user,generation,callId:call.id,peer,connection,source};
  const owner=streamOwners.get(stream);if(owner&&!same(owner,binding))return;
  if(tracks.some(track=>{const prior=trackOwners.get(track);return prior&&!same(prior,binding);}))return;
  streamOwners.set(stream,binding);for(const track of tracks)trackOwners.set(track,binding);
  let active=true,failed=false;
  const current=()=>{const state=useP2PCallStore.getState(),live=state.activeCall,now=stream.getAudioTracks().filter(track=>track.readyState!=="ended");return active&&useAuthStore.getState().user?.id===user&&getAuthSessionSnapshot().ownerId===user&&getAuthSessionSnapshot().generation===generation&&live===call&&live?.id===call.id&&live.status==="active"&&live.caller_id===call.caller_id&&live.receiver_id===call.receiver_id&&state.peerConnection===connection&&selected(source)===stream&&useVoiceStore.getState().outputDevice===output&&now.length===tracks.length&&now.every((track,index)=>track===tracks[index]);};
  const instance=tracks.length?playPrivateAudio(stream,{outputDevice:output,volume:volume(peer,source),isCurrent:current,onFailure:()=>{if(current()){failed=true;setStatus({key,stream,connection,failed:true});}}}):null;
  const changed=()=>{if(!active)return;instance?.stop();bump(value=>value+1);};
  stream.addEventListener("addtrack",changed);stream.addEventListener("removetrack",changed);for(const track of tracks)track.addEventListener("ended",changed);
  const retire=()=>{if(!current())instance?.stop();};
  const offs=[useP2PCallStore.subscribe(retire),subscribeAuthOwnerChanges(retire),subscribeAuthGenerationChanges(retire),useVoiceStore.subscribe(()=>{if(!current())instance?.stop();else instance?.setVolume(volume(peer,source));})];
  if(instance)void instance.ready.then(result=>{if(current()&&!failed)setStatus(result.fallback?{key,stream,connection,failed:false}:null);},()=>{});
  return()=>{active=false;offs.forEach(off=>off());stream.removeEventListener("addtrack",changed);stream.removeEventListener("removetrack",changed);for(const track of tracks)track.removeEventListener("ended",changed);instance?.stop();};
 },[user,generation,call,connection,stream,source,output,key]);
 if(status?.key!==key||status.stream!==stream||status.connection!==connection)return null;
 return <div className="p2p-audio-status" role={status.failed?"alert":"status"}><strong>{t(source==="screen"?"p2pScreenAudioSource":"p2pMicrophoneAudioSource")}</strong><p>{t(status.failed?"p2pAudioFailed":"p2pAudioFallback")}</p>{status.failed&&<button type="button" onClick={()=>setRetry(value=>value+1)}>{t("p2pAudioRetry")}</button>}</div>;
}
export default function P2PAudioSink(){return <><SourceSink source="microphone"/><SourceSink source="screen"/></>;}
