import {resolvePublicAssetBase}from "./publicAssetBase";
import {isNativeApp}from "../utils/constants";
export function systemAudioWorkletURL(href:string,native:boolean,base:string){return new URL(resolvePublicAssetBase("pcm-feeder-processor.js",native,base),href).href;}
import {getAuthSessionSnapshot,subscribeAuthGenerationChanges,subscribeAuthOwnerChanges}from "../api/authSessionEvents";
export type SystemAudioState={phase:"idle"|"starting"|"ready"|"failed";reason?:string};
type Options={kind:"guild"|"p2p"|"group";source:string;current:()=>boolean;subscribeCurrent?:(retire:()=>void)=>()=>void;state?:(status:SystemAudioState)=>void};
type Header={sampleRate:number;channels:number;bitsPerSample:number;formatTag:number};
/** Existing WASAPI PCM→worklet path, owned by one exact capture lease. */
export class SystemAudioCaptureSession {
 private options:Options;private auth=JSON.stringify(getAuthSessionSnapshot());private disposed=false;private lease:string|null=null;
 private api=window.electronAPI;private cleanups:Array<()=>void>=[];private unsubscribe:(()=>void)|null=null;
 private context:AudioContext|null=null;private worklet:AudioWorkletNode|null=null;private destination:MediaStreamAudioDestinationNode|null=null;private track:MediaStreamTrack|null=null;
 private timer:number|undefined;private started=false;private settled=false;private headerStarted=false;private backlog=0;
 private readyResolve:((track:MediaStreamTrack)=>void)|null=null;private readyReject:((error:Error)=>void)|null=null;
 constructor(options:Options){this.options=options;const retire=()=>{if(!this.current())this.stop();};this.cleanups.push(subscribeAuthOwnerChanges(retire),subscribeAuthGenerationChanges(retire));if(options.subscribeCurrent){const cleanup=options.subscribeCurrent(retire);if(this.disposed)cleanup();else this.cleanups.push(cleanup);}}
 private current(){try{return !this.disposed&&JSON.stringify(getAuthSessionSnapshot())===this.auth&&this.options.current();}catch{return false;}}
 private notify(status:SystemAudioState){this.options.state?.(status);}
 private release(id:string){void this.api?.releaseSystemCaptureLease(id).catch(()=>{});}
 private cleanup(){this.unsubscribe?.();this.unsubscribe=null;for(const off of this.cleanups)off();this.cleanups=[];if(this.timer!==undefined)window.clearTimeout(this.timer);this.timer=undefined;this.track?.stop();this.track=null;this.worklet?.disconnect();this.worklet=null;this.destination?.disconnect();this.destination=null;const context=this.context;this.context=null;if(context)void context.close().catch(()=>{});if(this.lease)this.release(this.lease);this.lease=null;}
 private fail(reason:string){if(this.disposed)return;this.disposed=true;this.cleanup();if(!this.settled){this.settled=true;this.readyReject?.(new Error(reason));}this.notify({phase:"failed",reason});}
 stop(){if(this.disposed)return;this.disposed=true;this.cleanup();if(!this.settled){this.settled=true;this.readyReject?.(new DOMException("System audio capture cancelled","AbortError"));}this.notify({phase:"idle"});}
 start():Promise<MediaStreamTrack>{
  if(this.disposed)return Promise.reject(new DOMException("System audio source already retired","AbortError"));
  if(this.started)return Promise.reject(new Error("System audio source already started."));this.started=true;
  const ready=new Promise<MediaStreamTrack>((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
  if(!this.current()){this.stop();return ready;}
  const api=this.api;
  if(!api?.reserveSystemCaptureLease||!api.startSystemCaptureLease||!api.releaseSystemCaptureLease||!api.onSystemCaptureLeaseEvent){this.fail("unsupported");return ready;}
  this.notify({phase:"starting"});this.timer=window.setTimeout(()=>this.fail("startup_timeout"),5000);
  void api.reserveSystemCaptureLease({kind:this.options.kind,source:this.options.source}).then(id=>{
   if(!this.current()){this.release(id);this.stop();return;}this.lease=id;
   this.unsubscribe=api.onSystemCaptureLeaseEvent(event=>{
    if(event.leaseId!==this.lease)return;if(!this.current()){this.stop();return;}
    if(event.type==="header"){if(this.headerStarted)return;this.headerStarted=true;void this.header(event.value);}
    else if(event.type==="data")this.pcm(event.value);
    else if(event.type==="stopped")this.fail("helper_stopped");
   });
   return api.startSystemCaptureLease(id);
  }).catch(()=>{if(this.current())this.fail("capture_unavailable");});
  return ready;
 }
 private async header(value:unknown){
  const header=value as Partial<Header>|null;
  if(!header||!Number.isInteger(header.sampleRate)||header.sampleRate!<8000||header.sampleRate!>192000||!Number.isInteger(header.channels)||header.channels!<1||header.channels!>8||!((header.formatTag===3&&header.bitsPerSample===32)||(header.formatTag===1&&header.bitsPerSample===16))){this.fail("invalid_audio_format");return;}
  const format=header as Header;
  try{
   const context=new AudioContext({sampleRate:format.sampleRate});this.context=context;
   await context.audioWorklet.addModule(systemAudioWorkletURL(window.location.href,isNativeApp(),import.meta.env.BASE_URL));
   if(!this.current()||this.context!==context){this.stop();return;}
   const node=new AudioWorkletNode(context,"pcm-feeder",{outputChannelCount:[format.channels],processorOptions:{channelCount:format.channels}});this.worklet=node;
   const destination=context.createMediaStreamDestination();this.destination=destination;node.connect(destination);
   const track=destination.stream.getAudioTracks()[0];if(!track)throw new Error("No system audio output track");track.enabled=false;this.track=track;
   const ended=()=>this.fail("audio_track_ended");track.addEventListener("ended",ended);this.cleanups.push(()=>track.removeEventListener("ended",ended));
   node.port.onmessage=event=>{if(event.data==="processed")this.backlog=Math.max(0,this.backlog-1);};
   await context.resume();
   if(!this.current()||this.context!==context){this.stop();return;}
   if(track.readyState==="ended"){this.fail("audio_track_ended");return;}
   if(context.state!=="running")throw new Error("Audio context is not running");
   this.format=format;this.settled=true;if(this.timer!==undefined)window.clearTimeout(this.timer);this.timer=undefined;this.notify({phase:"ready"});this.readyResolve?.(track);
  }catch{if(this.current())this.fail("worklet_setup");}
 }
 private format:Header|null=null;
 private pcm(value:unknown){
  if(!this.current()||!this.format||!this.worklet||this.backlog>16||!ArrayBuffer.isView(value)||!("BYTES_PER_ELEMENT"in value)||value.BYTES_PER_ELEMENT!==1)return;
  const data=new Uint8Array(value.buffer,value.byteOffset,value.byteLength),bytes=this.format.bitsPerSample/8,samples=new DataView(data.buffer,data.byteOffset,data.byteLength),output=new Float32Array(Math.floor(data.byteLength/bytes));
  for(let index=0;index<output.length;index++)output[index]=this.format.formatTag===3?samples.getFloat32(index*4,true):samples.getInt16(index*2,true)/32768;
  try{this.backlog++;this.worklet.port.postMessage(output,[output.buffer]);}catch{this.fail("worklet_feed");}
 }
}
