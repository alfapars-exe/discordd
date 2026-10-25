import { RoomEvent, Track, type Room, type RemoteTrack, type RemoteParticipant, type RemoteTrackPublication } from "livekit-client";
import { useVoiceStore } from "../stores/voiceStore";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { playPrivateAudio, type PrivatePlayback } from "./privatePlayback";

const bounded = (value:number,max:number) => Number.isFinite(value) ? Math.max(0,Math.min(max,value)) : 0;
/** One owner for each borrowed remote track. Guild moderation never controls a
 * private call. Graph teardown stops only derived output, never remote media. */
export function privateRoomPlayback(room:Room, onStatus:(status:"ready"|"fallback"|"failed")=>void,isCurrentSource:()=>boolean=()=>true) {
 const auth=getAuthSessionSnapshot(),owner=JSON.stringify(auth);
 let active=true, output=useVoiceStore.getState().outputDevice;
 const players=new Map<RemoteTrack,{peer:string;participant:RemoteParticipant;ownership:{active:boolean};source:Track.Source;status:"ready"|"fallback"|"failed";player:PrivatePlayback}>();
 const current=()=>active&&isCurrentSource()&&!!auth.ownerId&&JSON.stringify(getAuthSessionSnapshot())===owner;
 const volume=(peer:string,source:Track.Source)=>{
  const state=useVoiceStore.getState();
  if(state.isDeafened||state.localMutedUsers[peer])return 0;
  const personal=source===Track.Source.ScreenShareAudio?state.screenShareVolumes[peer]:state.userVolumes[peer];
  return bounded(state.masterVolume,100)/100*bounded(personal??100,200)/100;
 };
 const status=()=>{if(current())onStatus([...players.values()].some(item=>item.status==="failed")?"failed":[...players.values()].some(item=>item.status==="fallback")?"fallback":"ready");};
 const stopTrack=(track:RemoteTrack)=>{const item=players.get(track);if(item){item.ownership.active=false;item.player.stop();}players.delete(track);status();};
 const stopPlayers=()=>{for(const item of players.values()){item.ownership.active=false;item.player.stop();}players.clear();};
 const add=(track:RemoteTrack,publication:RemoteTrackPublication,peer:RemoteParticipant)=>{
  if(!current()||track.kind!==Track.Kind.Audio||players.has(track))return;
  if(room.remoteParticipants.get(peer.identity)!==peer||peer.trackPublications.get(publication.trackSid)!==publication)return;
  const media=track.mediaStreamTrack;
  const boundOutput=output,ownership={active:true};
  const player=playPrivateAudio(new MediaStream([media]),{outputDevice:boundOutput,volume:volume(peer.identity,publication.source),
   isCurrent:()=>ownership.active&&current()&&output===boundOutput&&room.remoteParticipants.get(peer.identity)===peer&&peer.trackPublications.get(publication.trackSid)===publication&&publication.track===track,
   onFailure:()=>{const item=players.get(track);if(ownership.active&&current()&&item?.player===player){item.status="failed";status();}},
  });
  players.set(track,{peer:peer.identity,participant:peer,ownership,source:publication.source,status:"ready",player});
  void player.ready.then(result=>{if(current()&&players.get(track)?.player===player){players.get(track)!.status=result.fallback?"fallback":"ready";status();}},()=>{});
 };
 const scan=()=>room.remoteParticipants.forEach(peer=>peer.trackPublications.forEach(publication=>{if(publication.track)add(publication.track,publication,peer);}));
 const removeParticipant=(peer:RemoteParticipant)=>{for(const [track,item]of players)if(item.participant===peer)stopTrack(track);};
 const retireAuth=()=>{if(!current())stopPlayers();};
 const unsubscribeOwner=subscribeAuthOwnerChanges(retireAuth),unsubscribeGeneration=subscribeAuthGenerationChanges(retireAuth);
 const unsubscribeVoice=useVoiceStore.subscribe(()=>{
  if(!current()){stopPlayers();return;}
  const next=useVoiceStore.getState().outputDevice;
  if(next!==output){output=next;stopPlayers();scan();return;}
  for(const item of players.values())item.player.setVolume(volume(item.peer,item.source));
 });
 room.on(RoomEvent.TrackSubscribed,add);room.on(RoomEvent.TrackUnsubscribed,stopTrack);room.on(RoomEvent.ParticipantDisconnected,removeParticipant);
 scan();
 return ()=>{active=false;unsubscribeOwner();unsubscribeGeneration();unsubscribeVoice();room.off(RoomEvent.TrackSubscribed,add);room.off(RoomEvent.TrackUnsubscribed,stopTrack);room.off(RoomEvent.ParticipantDisconnected,removeParticipant);stopPlayers();};
}
