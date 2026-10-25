import {afterEach,beforeEach,expect,it,vi}from "vitest";
import {LocalVideoTrack,Room,type LocalParticipant}from "livekit-client";
import {OwnedCamera,type CameraStatus}from "./ownedCamera";
import {registerCaptureAdmission}from "./microphoneAdmission";
import {useVoiceStore}from "../stores/voiceStore";
import {publishAuthOwnerChange,publishAuthGenerationChange}from "../api/authSessionEvents";
function raw(id:string){let state="live";const target=new EventTarget();const result=Object.assign(target,{id,kind:"video",enabled:true,muted:false,getSettings:()=>({deviceId:id,width:1280,height:720}),getConstraints:()=>({}),applyConstraints:vi.fn(async()=>{}),stop:vi.fn(()=>{state="ended";}),end(){state="ended";target.dispatchEvent(new Event("ended"));}});Object.defineProperty(result,"readyState",{get:()=>state});return result as unknown as MediaStreamTrack&{end:()=>void};}
function stream(track:MediaStreamTrack){return{getVideoTracks:()=>[track],getTracks:()=>[track]}as MediaStream;}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
const all:OwnedCamera[]=[];
let capture:ReturnType<typeof vi.fn>;
beforeEach(()=>{publishAuthOwnerChange("owner");publishAuthGenerationChange(1);useVoiceStore.setState({cameraDevice:"selected",cameraQuality:"720p",cameraFps:30});capture=vi.fn();Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:capture}});vi.stubGlobal("MediaStream",class extends EventTarget{tracks:MediaStreamTrack[];constructor(tracks:MediaStreamTrack[]=[]){super();this.tracks=tracks;}getTracks(){return this.tracks;}getVideoTracks(){return this.tracks.filter(t=>t.kind==="video");}getAudioTracks(){return[];}});});
afterEach(()=>{for(const camera of all)camera.dispose();all.length=0;vi.unstubAllGlobals();vi.restoreAllMocks();});
function fixture(){const participant={publishTrack:vi.fn(async()=>({})),unpublishTrack:vi.fn(async()=>{})}as unknown as LocalParticipant;const admission=registerCaptureAdmission(participant,()=>true);admission.open();const status:CameraStatus[]=[],failed=vi.fn();const camera=new OwnedCamera(participant,()=>true,value=>status.push(value),failed);all.push(camera);return{camera,participant,status,failed,admission};}
it("captures video only with selected settings, publishes actual userProvided SDK video, applies live quality/FPS/device and turns hardware off",async()=>{
 const f=fixture(),first=raw("first"),second=raw("second");capture.mockResolvedValueOnce(stream(first)).mockResolvedValueOnce(stream(second));await f.camera.setEnabled(true);expect(first.enabled).toBe(true);expect(capture).toHaveBeenCalledWith({audio:false,video:{deviceId:{exact:"selected"},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}}});
 const track=vi.mocked(f.participant.publishTrack).mock.calls[0][0]as LocalVideoTrack;expect(track).toBeInstanceOf(LocalVideoTrack);expect(track.isUserProvided).toBe(true);
 useVoiceStore.setState({cameraDevice:"next",cameraQuality:"1080p",cameraFps:15});await f.camera.setEnabled(true);expect(first.stop).toHaveBeenCalled();expect(second.enabled).toBe(true);expect(capture).toHaveBeenLastCalledWith({audio:false,video:{deviceId:{exact:"next"},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:15}}});expect(f.participant.publishTrack).toHaveBeenLastCalledWith(expect.any(LocalVideoTrack),expect.objectContaining({videoEncoding:expect.objectContaining({maxFramerate:15})}));await f.camera.setEnabled(false);expect(second.stop).toHaveBeenCalled();expect(f.status.at(-1)?.phase).toBe("idle");
});
it("holds raw frames disabled until guarded publication completes and closes pending raw immediately on rekey",async()=>{
 const f=fixture(),source=raw("pending"),published=deferred<unknown>();capture.mockResolvedValue(stream(source));vi.mocked(f.participant.publishTrack).mockReturnValue(published.promise as never);const operation=f.camera.setEnabled(true);await vi.waitFor(()=>expect(f.participant.publishTrack).toHaveBeenCalledOnce());expect(source.enabled).toBe(false);f.admission.close();expect(source.stop).toHaveBeenCalled();expect(source.enabled).toBe(false);published.resolve({});await operation;expect(f.participant.unpublishTrack).toHaveBeenCalledWith(expect.any(LocalVideoTrack),true);expect(f.status.some(s=>s.phase==="active")).toBe(false);
});
it.each(["off","auth","replacement"])("late camera permission cannot reopen after %s and cannot stop replacement owner",async(reason)=>{
 const f=fixture(),late=raw("late"),pending=deferred<MediaStream>();capture.mockReturnValueOnce(pending.promise);const old=f.camera.setEnabled(true);let next:MediaStreamTrack|undefined;
 if(reason==="off")await f.camera.setEnabled(false);else if(reason==="auth")publishAuthGenerationChange(2);else{const replacement=new OwnedCamera(f.participant,()=>true,()=>{},()=>{});all.push(replacement);next=raw("replacement");capture.mockResolvedValueOnce(stream(next));await replacement.setEnabled(true);}
 pending.resolve(stream(late));await old;expect(late.stop).toHaveBeenCalled();expect(f.participant.publishTrack).toHaveBeenCalledTimes(reason==="replacement"?1:0);if(next)expect(next.enabled).toBe(true);
});
it("latest selection wins a slow permission race without serially waiting for stale picker",async()=>{
 const f=fixture(),old=deferred<MediaStream>(),stale=raw("stale"),latest=raw("latest");capture.mockReturnValueOnce(old.promise).mockResolvedValueOnce(stream(latest));const first=f.camera.setEnabled(true);useVoiceStore.setState({cameraDevice:"latest"});await f.camera.setEnabled(true);expect(latest.enabled).toBe(true);old.resolve(stream(stale));await first;expect(stale.stop).toHaveBeenCalled();expect(latest.enabled).toBe(true);expect(f.participant.publishTrack).toHaveBeenCalledOnce();
});
it("permission denial and ended capture require explicit recovery and never fall back or autoreacquire",async()=>{
 const f=fixture();capture.mockRejectedValueOnce(new DOMException("denied","NotAllowedError"));await f.camera.setEnabled(true);expect(f.status.at(-1)).toEqual({phase:"error",error:"cameraPermissionDenied"});expect(f.failed).toHaveBeenCalledOnce();useVoiceStore.setState({cameraDevice:"changed"});expect(capture).toHaveBeenCalledOnce();const recovered=raw("recovered");capture.mockResolvedValueOnce(stream(recovered));await f.camera.setEnabled(true);recovered.end();expect(f.status.at(-1)).toEqual({phase:"error",error:"cameraBusy"});expect(recovered.enabled).toBe(false);const error=f.status.at(-1)!;expect(f.camera.canRetry(error)).toBe(true);f.camera.dispose();expect(f.camera.canRetry(error)).toBe(false);expect(capture).toHaveBeenCalledTimes(2);
});
it("installed SDK ended handler mutes a userProvided camera without reacquiring",async()=>{
 const source=raw("sdk"),track=new LocalVideoTrack(source,{},true),restart=vi.spyOn(track,"restartTrack"),room=new Room();const ended=Reflect.get(room.localParticipant,"handleTrackEnded")as(track:LocalVideoTrack)=>Promise<void>;await ended.call(room.localParticipant,track);expect(track.isUserProvided).toBe(true);expect(track.isMuted).toBe(true);expect(restart).not.toHaveBeenCalled();expect(capture).not.toHaveBeenCalled();track.stop();await room.disconnect();
});

it.each(["mute","publish","unmute"])("reports a current camera silently ending during %s instead of leaving starting/active success",async(stage)=>{
 const f=fixture(),rawTrack=raw("silent"),gate=deferred<unknown>();capture.mockResolvedValue(stream(rawTrack));
 if(stage==="publish")vi.mocked(f.participant.publishTrack).mockReturnValue(gate.promise as never);
 else{const method=stage as "mute"|"unmute",original=LocalVideoTrack.prototype[method];vi.spyOn(LocalVideoTrack.prototype,method).mockImplementationOnce(async function(this:LocalVideoTrack){await gate.promise;return original.call(this);});}
 const operation=f.camera.setEnabled(true);if(stage==="mute")await Promise.resolve();else await vi.waitFor(()=>expect(f.participant.publishTrack).toHaveBeenCalled());rawTrack.stop();gate.resolve({});await operation;expect(f.status.at(-1)).toEqual({phase:"error",error:"cameraBusy"});expect(f.failed).toHaveBeenCalledOnce();expect(f.camera.canRetry(f.status.at(-1)!)).toBe(true);expect(rawTrack.enabled).toBe(false);
});
