import {useEffect,useRef,useState,useSyncExternalStore} from "react";
import {authorizedVideoSources,type AuthorizedVideoSource} from "../video/authorizedVideoSources";
import {createOverlayMediaSender,type OverlayMediaBridge} from "../video/overlayMediaBridge";
import {useVoiceStore} from "../stores/voiceStore";
import {useAuthStore} from "../stores/authStore";
import {getAuthSessionSnapshot,subscribeAuthOwnerChanges,subscribeAuthGenerationChanges} from "../api/authSessionEvents";
import {parseOverlayAvailability,type OverlayAvailability} from "../utils/overlayMediaUIContract";
import type {VideoViewportLease} from "../video/videoVisibilityCoordinator";
const ids=new WeakMap<object,number>();let nextId=0;
function identity(value:object){if(!ids.has(value))ids.set(value,++nextId);return ids.get(value);}
/** One selected authorized call only. Broker readiness precedes any cloning. */
export function useOverlayMediaSender(connected:boolean){
 const registry=useSyncExternalStore(authorizedVideoSources.subscribe,authorizedVideoSources.getSnapshot);
 const video=useVoiceStore(s=>s.voiceOverlayVideo),streams=useVoiceStore(s=>s.voiceOverlayStreams),enabled=useVoiceStore(s=>s.voiceOverlayEnabled);
 const owner=useAuthStore(s=>s.user?.id),auth=getAuthSessionSnapshot();
 const availabilityListeners=useRef(new Set<()=>void>());
 const [availability,setAvailability]=useState<OverlayAvailability|null>(null),liveAvailability=useRef<OverlayAvailability|null>(null);
 useEffect(()=>{const api=window.electronAPI;let active=true,revision=0;const receive=(raw:unknown)=>{if(!active)return;revision++;const value=parseOverlayAvailability(raw);liveAvailability.current=value;availabilityListeners.current.forEach(fn=>fn());setAvailability(previous=>JSON.stringify(previous)===JSON.stringify(value)?previous:value)};const off=api?.onOverlayMediaAvailability?.(receive);const captured=revision;void api?.getOverlayMediaAvailability?.().then(value=>{if(active&&revision===captured)receive(value)},()=>{if(active&&revision===captured)receive(null)});return()=>{active=false;off?.();liveAvailability.current=null}},[]);
 const context=registry.selected;
 const candidates=(context?.sources??[]).filter(source=>(source.kind==="camera"?video:streams)&&availability?.allowedKinds.includes(source.kind));
 const count={camera:0,screen:0};const sources=candidates.filter(source=>++count[source.kind]<=2);
 const sourceKey=sources.map(source=>identity(source)).join(":");
 useEffect(()=>{
  const api=window.electronAPI,scope=getAuthSessionSnapshot(),windowGeneration=availability?.windowGeneration;
  if(!connected||!enabled||!owner||scope.ownerId!==owner||!availability?.ready||!availability.visible||!context||!sources.length||!api?.openOverlayMediaLease||!api.sendOverlayMedia||!api.onOverlayMedia||!api.onOverlayMediaViewport)return;
  let active=true,retired=false,bridge:OverlayMediaBridge|null=null;const viewports=new Map<string,VideoViewportLease>();
  const session=crypto.randomUUID(),revision=1;
  const current=()=>{const auth=getAuthSessionSnapshot(),a=liveAvailability.current,v=useVoiceStore.getState(),selected=authorizedVideoSources.getSnapshot().selected;return active&&auth.ownerId===scope.ownerId&&auth.generation===scope.generation&&useAuthStore.getState().user?.id===scope.ownerId&&v.voiceOverlayEnabled&&a?.ready===true&&a.visible&&a.windowGeneration===windowGeneration&&selected?.nonce===context.nonce&&sources.every(source=>selected.sources.includes(source)&&source.current()&&a.allowedKinds.includes(source.kind)&&(source.kind==="camera"?v.voiceOverlayVideo:v.voiceOverlayStreams))};
  const retire=()=>{if(retired)return;retired=true;active=false;if(bridge)bridge.dispose();else void api.sendOverlayMedia!({protocol:1,session,revision,kind:"end",reason:"scope"}).catch(()=>{});for(const viewport of viewports.values())viewport.release();viewports.clear()};
  const check=()=>{if(!current())retire()};
  const subscribe=(fn:()=>void)=>{availabilityListeners.current.add(fn);const off=[()=>{availabilityListeners.current.delete(fn)},authorizedVideoSources.subscribe(fn),useVoiceStore.subscribe(fn),subscribeAuthOwnerChanges(fn),subscribeAuthGenerationChanges(fn)];return()=>off.forEach(stop=>stop())};
  const stopScope=subscribe(check);
  const offMedia=api.onOverlayMedia(raw=>{if(current())void bridge?.receive(raw)});
  const offViewport=api.onOverlayMediaViewport(raw=>{
   if(!current()||!raw||typeof raw!=="object")return;const v=raw as Record<string,unknown>;if(v.session!==session||v.revision!==revision||typeof v.tileId!=="string"||typeof v.visible!=="boolean")return;const source=sources.find(source=>source.tileId===v.tileId);if(!source)return;
   if(v.visible&&(![v.width,v.height,v.fps].every(n=>typeof n==="number"&&Number.isFinite(n)&&n>0)||(v.width as number)>1920||(v.height as number)>1080||(v.fps as number)>60))return;
   const value=v.visible?{surface:"overlay" as const,visible:true,width:v.width as number,height:v.height as number,fps:v.fps as number}:{surface:"overlay" as const,visible:false,width:0,height:0,fps:0};const existing=viewports.get(source.tileId);if(existing)existing.update(value);else{const lease=source.addViewport(value);if(lease)viewports.set(source.tileId,lease)}
  });
  void api.openOverlayMediaLease({session,revision,tiles:sources.map(source=>({tileId:source.tileId,kind:source.kind,label:context.label.slice(0,80)}))}).then(ok=>{
   if(!ok||!current()){retire();return;}
   bridge=createOverlayMediaSender({session,revision,sources:sources as AuthorizedVideoSource[],current,subscribeScope:subscribe,send:envelope=>{void api.sendOverlayMedia!(envelope).then(ok=>{if(!ok)retire()},retire)},onError:retire});
   if(!current()){retire();return;}void bridge?.start().then(ok=>{if(!ok)retire()});
  },retire);
  return()=>{retire();stopScope();offMedia();offViewport()};
 // Exact source object identities are security leases; array copies alone must not reopen a call.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[connected,enabled,owner,auth.ownerId,auth.generation,availability,context?.nonce,sourceKey,video,streams]);
}
