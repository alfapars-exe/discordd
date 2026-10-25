import {useLayoutEffect,useRef}from "react";
import {ConnectionState,RemoteVideoTrack,RoomEvent,Track,TrackPublication,type RemoteParticipant,type RemoteTrackPublication,type Room}from "livekit-client";
import {captureAdmissionCurrent,subscribeCaptureAdmission}from "../audio/microphoneAdmission";
import {bindAuthorizedVideoSources,setPublicationVideoSource,type AuthorizedVideoSource,type VideoSourceOwner}from "./authorizedVideoSources";
import {VideoVisibilityCoordinator}from "./videoVisibilityCoordinator";
import {isElectron}from "../utils/constants";
export const manualNativeVideo=()=>isElectron()&&/Windows/i.test(navigator.userAgent);
type Options={room:Room|null;nonce:string;owner:VideoSourceOwner;label:string;keyContext:string;keyEpoch:number;admitted:boolean;current:()=>boolean;authorized:(participant:RemoteParticipant,publication:RemoteTrackPublication)=>boolean;subscribe:(changed:()=>void)=>()=>void;presented?:()=>boolean};
/** No new subscription authority. Only exact already-subscribed admitted remote
 * publications become sources; all main views share their publication lease. */
export function useAuthorizedRoomVideos(options:Options){const latest=useRef(options),reconcileRef=useRef(()=>{});useLayoutEffect(()=>{latest.current=options});
 const{room:identityRoom,nonce,owner,label,keyContext,keyEpoch,admitted}=options;
 useLayoutEffect(()=>{const room=identityRoom;if(!room)return;let live=true;const listeners=new Set<()=>void>();
 const valid=()=>{try{return live&&latest.current.room===room&&latest.current.nonce===nonce&&latest.current.keyContext===keyContext&&latest.current.keyEpoch===keyEpoch&&latest.current.admitted&&latest.current.current()&&captureAdmissionCurrent(room.localParticipant)}catch{return false}};
 const scope={room,sessionNonce:nonce,keyContext,keyEpoch};
 const notify=()=>{for(const changed of [...listeners]){try{changed()}catch{ /* Continue exact-source retirement. */ }}};
 const coordinator=new VideoVisibilityCoordinator({scope,currentScope:()=>live&&latest.current.room===room&&latest.current.nonce===nonce&&latest.current.keyContext===keyContext&&latest.current.keyEpoch===keyEpoch?scope:null,isAdmitted:valid,subscribeScope:changed=>{listeners.add(changed);return()=>{listeners.delete(changed)}}});
 const binding=bindAuthorizedVideoSources(owner,nonce,label,valid,()=>latest.current.presented?.()??false);
 const entries=new Map<RemoteTrackPublication,{source:AuthorizedVideoSource;release:()=>void;track:RemoteVideoTrack;raw:MediaStreamTrack}>();
 const reconcile=()=>{if(!live)return;const seen=new Set<RemoteTrackPublication>();
  if(valid()&&room.state===ConnectionState.Connected)room.remoteParticipants.forEach(participant=>participant.trackPublications.forEach(publication=>{const pub=publication as RemoteTrackPublication,track=pub.track;if(!(track instanceof RemoteVideoTrack)||pub.kind!==Track.Kind.Video||pub.isLocal||!pub.isSubscribed||pub.isMuted||track.isMuted||pub.permissionStatus!==TrackPublication.PermissionStatus.Allowed||![Track.Source.Camera,Track.Source.ScreenShare].includes(pub.source)||!latest.current.authorized(participant,pub))return;
   seen.add(pub);const existing=entries.get(pub);if(existing?.track===track&&existing.raw===track.mediaStreamTrack)return;existing?.release();entries.delete(pub);
   const raw=track.mediaStreamTrack;let active=true;
   const current=()=>active&&valid()&&room.state===ConnectionState.Connected&&room.remoteParticipants.get(participant.identity)===participant&&participant.trackPublications.get(pub.trackSid)===pub&&pub.track===track&&pub.isSubscribed&&!pub.isMuted&&!track.isMuted&&pub.permissionStatus===TrackPublication.PermissionStatus.Allowed&&track.mediaStreamTrack===raw&&raw.readyState==="live"&&latest.current.authorized(participant,pub);
   const lease=coordinator.register(participant,pub,current);
   const source:AuthorizedVideoSource={tileId:crypto.randomUUID(),kind:pub.source===Track.Source.Camera?"camera":"screen",track,current,subscribeScope:changed=>{listeners.add(changed);return()=>{listeners.delete(changed)}},addViewport:value=>lease?.addViewport(value)??null};
   const unmap=setPublicationVideoSource(pub,source);raw.addEventListener("ended",reconcile);entries.set(pub,{source,track,raw,release:()=>{active=false;raw.removeEventListener("ended",reconcile);unmap();lease?.release()}});
  }));
  for(const [pub,entry]of entries)if(!seen.has(pub)){entry.release();entries.delete(pub)}
  coordinator.refresh();binding.update([...entries.values()].map(entry=>entry.source));notify();
 };
 const events=[RoomEvent.TrackMuted,RoomEvent.TrackUnmuted,RoomEvent.TrackSubscribed,RoomEvent.TrackUnsubscribed,RoomEvent.TrackUnpublished,RoomEvent.TrackSubscriptionPermissionChanged,RoomEvent.ParticipantDisconnected,RoomEvent.ConnectionStateChanged]as const;
 reconcileRef.current=reconcile;events.forEach(event=>room.on(event,reconcile));
 const unsubscribe=latest.current.subscribe(reconcile),admission=subscribeCaptureAdmission(room.localParticipant,reconcile);reconcile();
 return()=>{if(reconcileRef.current===reconcile)reconcileRef.current=()=>{};live=false;notify();unsubscribe();admission();events.forEach(event=>room.off(event,reconcile));for(const entry of entries.values())entry.release();entries.clear();coordinator.dispose();binding.release();listeners.clear()};
 // Mutable policy is read through latest; identity/epoch replacements retire exact leases.
 },[identityRoom,nonce,owner,label,keyContext,keyEpoch,admitted]);
 useLayoutEffect(()=>{reconcileRef.current()});
}
