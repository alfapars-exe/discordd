import {LocalVideoTrack,Track,type LocalParticipant}from "livekit-client";
import {getAuthSessionSnapshot,subscribeAuthGenerationChanges,subscribeAuthOwnerChanges}from "../api/authSessionEvents";
import {useVoiceStore}from "../stores/voiceStore";
import {cameraConstraintsFor,cameraErrorKey}from "../utils/cameraCapture";
import {cameraPublishDefaultsFor}from "../hooks/useCameraPublishDefaults";
import {captureAdmissionCurrent,subscribeCaptureAdmission}from "./microphoneAdmission";
export type CameraStatus={phase:"idle"|"starting"|"active"|"error";error?:string};
type Resource={raw:MediaStreamTrack;track:LocalVideoTrack;remove:()=>void};
const owners=new WeakMap<LocalParticipant,OwnedCamera>();
const settings=()=>{const s=useVoiceStore.getState();return{quality:s.cameraQuality,fps:s.cameraFps,device:s.cameraDevice};};
/** Exact media owner. SDK device/ended recapture is disabled by userProvided tracks. */
export class OwnedCamera {
 private disposed=false;private requested=false;private generation=0;private applied="";
 private resources=new Set<Resource>();private published:Resource|null=null;
 private commits:Promise<void>=Promise.resolve();private work:Promise<void>=Promise.resolve();
 private status:CameraStatus={phase:"idle"};private cleanups:Array<()=>void>=[];
 private auth=JSON.stringify(getAuthSessionSnapshot());private owner=getAuthSessionSnapshot().ownerId;
 private participant:LocalParticipant;private currentSource:()=>boolean;private notify:(status:CameraStatus)=>void;private failed:()=>void;
 constructor(participant:LocalParticipant,currentSource:()=>boolean,notify:(status:CameraStatus)=>void,failed:()=>void,subscribeSource?:(retire:()=>void)=>()=>void){
  this.participant=participant;this.currentSource=currentSource;this.notify=notify;this.failed=failed;
  owners.get(participant)?.dispose();owners.set(participant,this);
  const retire=()=>{if(!this.current())this.dispose();};
  this.cleanups.push(subscribeAuthOwnerChanges(retire),subscribeAuthGenerationChanges(retire),subscribeCaptureAdmission(participant,()=>this.dispose()));
  if(subscribeSource)this.cleanups.push(subscribeSource(retire));
  this.cleanups.push(useVoiceStore.subscribe(()=>{if(!this.current()){this.dispose();return;}const next=JSON.stringify(settings());if(this.requested&&next!==this.applied){this.work=this.start();}}));
 }
 private current(){try{return !!this.owner&&!this.disposed&&owners.get(this.participant)===this&&JSON.stringify(getAuthSessionSnapshot())===this.auth&&captureAdmissionCurrent(this.participant)&&this.currentSource();}catch{return false;}}
 private report(status:CameraStatus){this.status=status;this.notify(status);}
 private stop(resource:Resource){resource.raw.enabled=false;resource.remove();resource.track.stop();this.resources.delete(resource);}
 private clear(){for(const resource of [...this.resources])this.stop(resource);const old=this.published;this.published=null;if(old)this.commits=this.commits.catch(()=>{}).then(async()=>{await this.participant.unpublishTrack(old.track,true).catch(()=>{});});}
 private failure(error:unknown,id:number){if(id!==this.generation||!this.current())return;this.requested=false;++this.generation;this.clear();this.report({phase:"error",error:cameraErrorKey(error)});this.failed();}
 canRetry(status:CameraStatus){return this.current()&&this.status===status&&status.phase==="error";}
 setEnabled(value:boolean):Promise<void>{
  if(!this.current())return Promise.resolve();
  if(!value){if(this.requested||this.status.phase==="starting"||this.status.phase==="active"){this.requested=false;++this.generation;this.clear();this.report({phase:"idle"});}return Promise.resolve();}
  if(this.requested)return this.work;
  this.requested=true;this.work=this.start();return this.work;
 }
 private async start(){
  if(!this.current()||!this.requested)return;
  const id=++this.generation,chosen=settings();this.applied=JSON.stringify(chosen);this.clear();this.report({phase:"starting"});
  const valid=()=>id===this.generation&&this.current()&&this.requested;
  let candidate:Resource|undefined;
  try{
   const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:cameraConstraintsFor(chosen.quality,chosen.fps,chosen.device)});
   const raw=stream.getVideoTracks()[0];for(const extra of stream.getTracks())if(extra!==raw)extra.stop();
   if(!raw)throw new DOMException("Camera unavailable","NotFoundError");
   raw.enabled=false;if(!valid()||raw.readyState!=="live"){raw.stop();if(valid())throw new DOMException("Camera disconnected","NotReadableError");return;}
   const track=new LocalVideoTrack(raw,cameraConstraintsFor(chosen.quality,chosen.fps,chosen.device),true);track.source=Track.Source.Camera;
   const ended=()=>this.failure(new DOMException("Camera disconnected","NotReadableError"),id);
   raw.addEventListener("ended",ended);candidate={raw,track,remove:()=>raw.removeEventListener("ended",ended)};this.resources.add(candidate);
   const resource=candidate,ensureLive=()=>{if(raw.readyState!=="live")throw new DOMException("Camera disconnected","NotReadableError");};
   await track.mute();raw.enabled=false;if(!valid())return;ensureLive();
   this.commits=this.commits.catch(()=>{}).then(async()=>{
    if(!valid())return;ensureLive();
    const options=cameraPublishDefaultsFor(chosen.quality,chosen.fps,chosen.device);
    await this.participant.publishTrack(track,{source:Track.Source.Camera,...options.cameraPublish});
    if(!valid()){raw.enabled=false;await this.participant.unpublishTrack(track,true).catch(()=>{});return;}
    this.published=resource;ensureLive();await track.unmute();
    if(!valid()){raw.enabled=false;await this.participant.unpublishTrack(track,true).catch(()=>{});return;}ensureLive();
    raw.enabled=true;this.report({phase:"active"});
   });await this.commits;
  }catch(error){this.failure(error,id);}
  finally{if(candidate&&(!valid()||this.published!==candidate)&&this.resources.has(candidate)){if(this.published===candidate)this.published=null;this.stop(candidate);}}
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.requested=false;++this.generation;for(const cleanup of this.cleanups)cleanup();this.cleanups=[];this.clear();this.report({phase:"idle"});if(owners.get(this.participant)===this)owners.delete(this.participant);}
}
