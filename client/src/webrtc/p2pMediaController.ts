import type { P2PMediaSource, P2PSignalPayload } from "../types/p2p";
import { parseP2PMediaSDP, validateP2PDescription } from "./p2pMediaProtocol";
export type P2PRemoteMedia={microphone:MediaStream|null;screenAudio:MediaStream|null;video:MediaStream|null;camera?:MediaStream|null;screenVideo?:MediaStream|null;screenAudioSupported:boolean};
type SourceLease={sender:RTCRtpSender;track:MediaStreamTrack;source:P2PMediaSource};
type SourceWaiter=SourceLease&{current:()=>boolean;promise:Promise<boolean>;finish:(accepted:boolean)=>void};
type Options={callId:string;polite:boolean;isCaller:boolean;isCurrent:()=>boolean;send:(op:string,data:unknown)=>void;onMedia:(media:P2PRemoteMedia)=>void;onError:(error:unknown)=>void;onDispose?:()=>void};
const controllers=new WeakMap<RTCPeerConnection,P2PMediaController>();
export const getP2PMediaController=(pc:RTCPeerConnection)=>controllers.get(pc);
export const registerP2PLocalSource=(pc:RTCPeerConnection,sender:RTCRtpSender,source:P2PMediaSource|null)=>controllers.get(pc)?.setLocalSource(sender,source);
/** One actual peer owns negotiation revisions and SDP-authorized receiver tracks. */
export class P2PMediaController {
 private retired=false;private serial=Promise.resolve();private queued=false;private dirty=false;
 private localRevision=0;private remoteRevision=0;private protocol:"unknown"|"legacy"|"v1"="unknown";
 private pendingSources:SourceLease[]=[];private acknowledged:SourceLease[]=[];private waiters:SourceWaiter[]=[];
 private pendingOffer:string|null=null;private staging=false;private legacyMicrophone:string|null=null;
 private pendingTracks=new Map<RTCRtpTransceiver,MediaStreamTrack>();
 private sourceMap=new Map<string,P2PMediaSource>();private acceptedReceivers=new Map<RTCRtpTransceiver,MediaStreamTrack>();
 private localSources=new Map<RTCRtpSender,P2PMediaSource>();private remoteTracks=new Map<RTCRtpTransceiver,{track:MediaStreamTrack;ended:()=>void}>();
 private media:P2PRemoteMedia={microphone:null,screenAudio:null,video:null,screenAudioSupported:false};
 readonly pc:RTCPeerConnection;private options:Options;
 constructor(pc:RTCPeerConnection,options:Options){this.pc=pc;this.options=options;controllers.get(pc)?.dispose();controllers.set(pc,this)}
 private current(){return !this.retired&&this.options.isCurrent()&&this.pc.signalingState!=="closed"}
 private enqueue<T>(task:()=>Promise<T>):Promise<T>{const result=this.serial.catch(()=>{}).then(task);this.serial=result.then(()=>{},()=>{});return result}
 setLocalSource(sender:RTCRtpSender,source:P2PMediaSource|null){
  if(!this.current()||!this.pc.getSenders().includes(sender))return;
  if(source&&sender.track&&sender.track.kind!==(source==="microphone"||source==="screen-audio"?"audio":"video"))throw new Error("Local source kind mismatch");
  if(this.localSources.get(sender)===source||source===null&&!this.localSources.has(sender))return;
  this.acknowledged=this.acknowledged.filter(lease=>lease.sender!==sender);for(const waiter of [...this.waiters])if(waiter.sender===sender)waiter.finish(false);if(source)this.localSources.set(sender,source);else this.localSources.delete(sender);this.requestNegotiation();
 }
 getLocalSource(sender:RTCRtpSender):P2PMediaSource|null{return this.current()?this.localSources.get(sender)??null:null}
 canSendScreenAudio(){return this.current()&&this.protocol==="v1"&&this.media.screenAudioSupported}
 waitUntilLocalSourceNegotiated(sender:RTCRtpSender,source:P2PMediaSource,isCurrent:()=>boolean,timeoutMs=10000):Promise<boolean>{
  const track=sender.track;if(!track||!this.current()||!this.canSendScreenAudio()||!isCurrent()||this.localSources.get(sender)!==source)return Promise.resolve(false);
  const direction=this.pc.getTransceivers().find(value=>value.sender===sender)?.currentDirection;
  if((direction==="sendrecv"||direction==="sendonly")&&this.pc.signalingState==="stable"&&this.acknowledged.some(lease=>lease.sender===sender&&lease.track===track&&lease.source===source))return Promise.resolve(true);
  const existing=this.waiters.find(lease=>lease.sender===sender&&lease.track===track&&lease.source===source);if(existing)return existing.promise;
  let finish!:(accepted:boolean)=>void;const promise=new Promise<boolean>(resolve=>{finish=resolve});
  let settled=false;const timer=setTimeout(()=>waiter.finish(false),Math.min(10000,Math.max(1,timeoutMs)));
  const waiter:SourceWaiter={sender,track,source,current:isCurrent,promise,finish:accepted=>{if(settled)return;settled=true;clearTimeout(timer);this.waiters=this.waiters.filter(value=>value!==waiter);finish(accepted)}};
  this.waiters.push(waiter);this.requestNegotiation();return promise;
 }
 private confirmSources(data:P2PSignalPayload){
  for(const waiter of [...this.waiters]){
   const transceiver=this.pc.getTransceivers().find(value=>value.sender===waiter.sender);
   const negotiated=transceiver?.currentDirection==="sendrecv"||transceiver?.currentDirection==="sendonly";
   const included=this.pendingSources.some(lease=>lease.sender===waiter.sender&&lease.track===waiter.track&&lease.source===waiter.source);
   const valid=this.canSendScreenAudio()&&this.current()&&waiter.current()&&waiter.sender.track===waiter.track&&this.localSources.get(waiter.sender)===waiter.source;
   if(!valid){waiter.finish(false);continue}
   // A prior offer may have been in flight before this source was registered.
   // Its answer cannot acknowledge or reject a source it never described.
   if(!included)continue;
   const accepted=data.media_protocol===1&&data.reply_to_description_id===this.pendingOffer&&negotiated;
   if(accepted)this.acknowledged.push({sender:waiter.sender,track:waiter.track,source:waiter.source});waiter.finish(accepted);
  }
 }
 requestNegotiation(){this.dirty=true;if(this.queued||!this.current())return;this.queued=true;queueMicrotask(()=>{this.queued=false;void this.enqueue(()=>this.offer()).catch(error=>{if(this.current())this.options.onError(error)})})}
 private outgoing(type:"offer"|"answer",reply?:string):P2PSignalPayload{
  const description=this.pc.localDescription;if(!description?.sdp)throw new Error("Missing local description");
  const base:P2PSignalPayload={call_id:this.options.callId,type,sdp:description.sdp};
  if(this.protocol==="legacy"||type==="answer"&&!reply)return base;
  const sections=parseP2PMediaSDP(description.sdp),sources:P2PSignalPayload["sources"]=[];
  for(const transceiver of this.pc.getTransceivers()){const source=this.localSources.get(transceiver.sender),mid=transceiver.mid,track=transceiver.sender.track;
   if(!source||!track||track.readyState==="ended"||!mid||!sections.some(section=>section.mid===mid&&section.active&&section.sends))continue;
   if(source==="screen-audio"&&!this.canSendScreenAudio())continue;sources.push({mid,source});
  }
  const result:P2PSignalPayload={...base,media_protocol:1,description_id:crypto.randomUUID(),description_revision:++this.localRevision,capabilities:["screen-audio-v1"],sources};if(reply)result.reply_to_description_id=reply;
  validateP2PDescription(result);return result;
 }
 private async offer(){if(!this.current()||!this.dirty||this.pc.signalingState!=="stable"||!this.options.isCaller&&this.protocol==="unknown")return;this.dirty=false;
  const offer=await this.pc.createOffer();if(!this.current())return;await this.pc.setLocalDescription(offer);if(!this.current())return;
  const signal=this.outgoing("offer");this.pendingOffer=signal.description_id??"legacy";
  this.pendingSources=this.pc.getTransceivers().flatMap(transceiver=>{const source=this.localSources.get(transceiver.sender),track=transceiver.sender.track;return source&&track&&signal.sources?.some(value=>value.mid===transceiver.mid&&value.source===source)?[{sender:transceiver.sender,track,source}]:[]});
  this.options.send("p2p_signal",signal);
 }
 async applyRemoteDescription(data:P2PSignalPayload):Promise<"accepted"|"ignored">{
  const validated=validateP2PDescription(data);return this.enqueue(async()=>{
   if(!this.current()||data.call_id!==this.options.callId)return"ignored";
   if(this.protocol==="v1"&&validated.protocol===0)return"ignored";
   if(validated.protocol===1&&(data.description_revision??0)<=this.remoteRevision)return"ignored";
   if(data.type==="answer"&&(!this.pendingOffer||this.pc.signalingState!=="have-local-offer"||validated.protocol===1&&data.reply_to_description_id!==this.pendingOffer))return"ignored";
   const collision=data.type==="offer"&&this.pc.signalingState!=="stable";
   if(collision&&!this.options.polite)return"ignored";
   if(collision){await this.pc.setLocalDescription({type:"rollback"});if(!this.current())return"ignored";this.pendingOffer=null;this.pendingSources=[]}
   this.staging=true;
   try{await this.pc.setRemoteDescription({type:data.type as "offer"|"answer",sdp:data.sdp})}catch(error){this.pendingTracks.clear();throw error}finally{this.staging=false}
   if(!this.current())return"ignored";
   this.protocol=validated.protocol===1?"v1":"legacy";if(validated.protocol===1)this.remoteRevision=data.description_revision!;
   if(validated.protocol===0&&this.legacyMicrophone===null)this.legacyMicrophone=validated.sections.find(section=>section.active&&section.sends&&section.kind==="audio")?.mid??null;
   this.sourceMap=validated.map;
   if(validated.protocol===0){this.sourceMap=new Map();for(const section of validated.sections){if(!section.active||!section.sends)continue;if(section.mid===this.legacyMicrophone)this.sourceMap.set(section.mid,"microphone");else if(section.kind==="video")this.sourceMap.set(section.mid,"camera")}}

   this.acceptedReceivers=new Map(this.pc.getTransceivers().filter(transceiver=>transceiver.mid&&validated.sections.some(section=>section.mid===transceiver.mid&&section.active&&section.sends)).map(transceiver=>[transceiver,transceiver.receiver.track]));
   for(const [transceiver,track]of this.pendingTracks)this.rememberTrack(transceiver,track);this.pendingTracks.clear();
   this.publish(validated.supportsScreenAudio);
   if(!validated.supportsScreenAudio){this.acknowledged=[];for(const waiter of [...this.waiters])waiter.finish(false)}
   if(data.type==="offer"){
    this.dirty=false;
    const answer=await this.pc.createAnswer();if(!this.current())return"ignored";await this.pc.setLocalDescription(answer);if(!this.current())return"ignored";
    const response=this.outgoing("answer",validated.protocol===1?data.description_id:undefined);this.pendingOffer=null;this.options.send("p2p_signal",response);
   }else{this.confirmSources(data);this.pendingOffer=null;this.pendingSources=[];}
   if(this.waiters.length)this.dirty=true;
   if(this.dirty)this.requestNegotiation();return"accepted";
  });
 }
 onTrack(event:RTCTrackEvent){if(!this.current()||!this.pc.getTransceivers().includes(event.transceiver)||event.transceiver.receiver.track!==event.track)return;
  if(this.staging){this.pendingTracks.set(event.transceiver,event.track);return}
  if(this.acceptedReceivers.get(event.transceiver)!==event.track)return;
  this.rememberTrack(event.transceiver,event.track);this.publish(this.media.screenAudioSupported);
 }
 private rememberTrack(transceiver:RTCRtpTransceiver,track:MediaStreamTrack){
  const old=this.remoteTracks.get(transceiver);old?.track.removeEventListener("ended",old.ended);
  const ended=()=>{if(this.remoteTracks.get(transceiver)?.track===track){this.remoteTracks.delete(transceiver);this.publish(this.media.screenAudioSupported)}};
  this.remoteTracks.set(transceiver,{track,ended});track.addEventListener("ended",ended);
 }

 private publish(supported:boolean){if(!this.current()||this.staging)return;
  const microphone:MediaStreamTrack[]=[],screenAudio:MediaStreamTrack[]=[],video:MediaStreamTrack[]=[],camera:MediaStreamTrack[]=[],screenVideo:MediaStreamTrack[]=[];
  for(const [transceiver,{track}]of this.remoteTracks){if(track.readyState==="ended"||this.acceptedReceivers.get(transceiver)!==track)continue;const source=this.sourceMap.get(transceiver.mid??"");
   if(source==="microphone"&&track.kind==="audio")microphone.push(track);else if(source==="screen-audio"&&track.kind==="audio"&&supported)screenAudio.push(track);else if((source==="camera"||source==="screen-video")&&track.kind==="video"){video.push(track);if(this.protocol==="v1"){if(source==="camera")camera.push(track);else screenVideo.push(track);}}
  }
  const stream=(old:MediaStream|null,tracks:MediaStreamTrack[])=>!tracks.length?null:old&&old.getTracks().length===tracks.length&&old.getTracks().every((track,index)=>track===tracks[index])?old:new MediaStream(tracks);
  const next={microphone:stream(this.media.microphone,microphone),screenAudio:stream(this.media.screenAudio,screenAudio),video:stream(this.media.video,video),camera:stream(this.media.camera??null,camera),screenVideo:stream(this.media.screenVideo??null,screenVideo),screenAudioSupported:supported};
  if(next.microphone!==this.media.microphone||next.screenAudio!==this.media.screenAudio||next.video!==this.media.video||next.camera!==this.media.camera||next.screenVideo!==this.media.screenVideo||next.screenAudioSupported!==this.media.screenAudioSupported){this.media=next;this.options.onMedia(next)}
 }
 dispose(){if(this.retired)return;this.retired=true;this.pendingOffer=null;this.pendingSources=[];this.acknowledged=[];for(const waiter of [...this.waiters])waiter.finish(false);for(const value of this.remoteTracks.values())value.track.removeEventListener("ended",value.ended);this.remoteTracks.clear();this.pendingTracks.clear();this.localSources.clear();this.sourceMap.clear();this.acceptedReceivers.clear();this.media={microphone:null,screenAudio:null,video:null,screenAudioSupported:false};controllers.delete(this.pc);this.options.onDispose?.()}
}
