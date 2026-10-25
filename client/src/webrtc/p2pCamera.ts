import {replaceOwnedVideoTrack}from "./videoSenderMutation";
import {getAuthSessionSnapshot,subscribeAuthGenerationChanges,subscribeAuthOwnerChanges}from "../api/authSessionEvents";
import {useVoiceStore}from "../stores/voiceStore";
import {cameraConstraintsFor}from "../utils/cameraCapture";
type Options={current:()=>boolean;sharing:()=>boolean;stream:MediaStream;pc:RTCPeerConnection;enabled:boolean;state:(enabled:boolean)=>void;busy:(pending:boolean)=>void;error:(error:unknown)=>void};
const selected=()=>{const s=useVoiceStore.getState();return{quality:s.cameraQuality,fps:s.cameraFps,device:s.cameraDevice};};
/** One accepted private call owns camera capture and its exact video sender. */
export class P2PCameraSession {
 private options:Options;private disposed=false;private wanted=false;private generation=0;
 private auth=JSON.stringify(getAuthSessionSnapshot());private raw:MediaStreamTrack|null=null;private unlisten:(()=>void)|null=null;
 private sender:RTCRtpSender|null=null;private candidates=new Set<MediaStreamTrack>();private stopped=new WeakSet<MediaStreamTrack>();
 private applied="";private cleanups:Array<()=>void>=[];private commits:Promise<void>=Promise.resolve();
 constructor(options:Options){
  this.options=options;this.wanted=options.enabled;this.raw=options.stream.getVideoTracks()[0]??null;this.applied=JSON.stringify(selected());
  if(this.raw)this.sender=options.pc.getSenders().find(s=>s.track===this.raw)??null;
  const retire=()=>{if(!this.current())this.dispose();};
  this.cleanups.push(subscribeAuthOwnerChanges(retire),subscribeAuthGenerationChanges(retire),useVoiceStore.subscribe(()=>{if(!this.current()){this.dispose();return;}if(this.wanted&&JSON.stringify(selected())!==this.applied)void this.capture();}));
 }
 activate(){if(this.current()&&this.raw&&this.wanted)this.watch(this.raw);}
 private current(){try{return !this.disposed&&JSON.stringify(getAuthSessionSnapshot())===this.auth&&this.options.current();}catch{return false;}}
 private stop(track:MediaStreamTrack){if(this.stopped.has(track))return;this.stopped.add(track);track.enabled=false;track.stop();}
 private clear(){this.unlisten?.();this.unlisten=null;if(this.raw)this.stop(this.raw);for(const candidate of this.candidates)this.stop(candidate);this.candidates.clear();}
 private fail(error:unknown,id:number){if(id!==this.generation||!this.current())return;this.wanted=false;++this.generation;this.clear();this.options.busy(false);this.options.state(false);this.options.error(error);}
 private watch(track:MediaStreamTrack){this.unlisten?.();const id=this.generation;const ended=()=>this.fail(new DOMException("Camera disconnected","NotReadableError"),id);track.addEventListener("ended",ended);this.unlisten=()=>track.removeEventListener("ended",ended);if(track.readyState==="ended")ended();}
 toggle(){if(!this.current())return;if(this.wanted){this.wanted=false;++this.generation;this.clear();this.options.busy(false);this.options.state(false);}else{this.wanted=true;void this.capture();}}
 private async capture(){
  if(!this.current()||!this.wanted)return;
  const id=++this.generation,choice=selected();this.applied=JSON.stringify(choice);this.clear();this.options.state(false);this.options.busy(true);
  const valid=()=>id===this.generation&&this.current()&&this.wanted;
  let candidate:MediaStreamTrack|undefined;
  try{
   const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:cameraConstraintsFor(choice.quality,choice.fps,choice.device)});
   candidate=stream.getVideoTracks()[0];for(const extra of stream.getTracks())if(extra!==candidate)extra.stop();
   if(!candidate)throw new DOMException("Camera unavailable","NotFoundError");candidate.enabled=false;this.candidates.add(candidate);
   if(!valid())return;if(candidate.readyState==="ended")throw new DOMException("Camera disconnected","NotReadableError");
   const next=candidate;const ended=()=>next.readyState==="ended";this.watch(next);
   this.commits=this.commits.catch(()=>{}).then(async()=>{
    if(!valid())return;if(ended())throw new DOMException("Camera disconnected","NotReadableError");
    if(!this.options.sharing()){
     if(this.sender&&!this.options.pc.getSenders().includes(this.sender))this.sender=null;
     if(!this.sender&&this.raw)this.sender=this.options.pc.getSenders().find(sender=>sender.track===this.raw)??null;
     if(this.sender){const attached=await replaceOwnedVideoTrack(this.sender,next,()=>valid()&&!this.options.sharing());if(!attached&&valid()&&!this.options.sharing())throw new DOMException("Camera sender changed","AbortError");}
     else this.sender=this.options.pc.addTrack(next,this.options.stream);
    }
    if(!valid())return;if(ended())throw new DOMException("Camera disconnected","NotReadableError");
    for(const old of this.options.stream.getVideoTracks()){this.options.stream.removeTrack(old);this.stop(old);}
    this.options.stream.addTrack(next);this.raw=next;this.candidates.delete(next);
    if(!valid())return;next.enabled=true;this.options.state(true);
   });await this.commits;
  }catch(error){this.fail(error,id);}
  finally{if(candidate&&this.candidates.delete(candidate))this.stop(candidate);if(id===this.generation&&this.current())this.options.busy(false);}
 }
 dispose(){if(this.disposed)return;this.disposed=true;++this.generation;this.wanted=false;for(const cleanup of this.cleanups)cleanup();this.cleanups=[];this.clear();this.options.busy(false);}
}
