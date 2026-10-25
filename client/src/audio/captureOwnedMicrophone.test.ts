import {beforeEach,describe,expect,it,vi}from "vitest";
import {LocalAudioTrack,Room}from "livekit-client";
import {captureOwnedMicrophone}from "./captureOwnedMicrophone";
import type{MicrophoneSettings}from "./microphoneSettings";
const settings:MicrophoneSettings={inputDevice:"selected",micProfile:"konusma",noiseReduction:true,noiseReductionEngine:"rnnoise",noiseSuppressionLevel:"medium",micSensitivity:50,inputVolume:100,deepfilterSuppression:70};
function source(){return Object.assign(new EventTarget(),{id:"raw",kind:"audio",readyState:"live",enabled:true,muted:false,getSettings:()=>({deviceId:"selected"}),getConstraints:()=>({}),stop:vi.fn(),applyConstraints:vi.fn(async()=>{})})as unknown as MediaStreamTrack;}
beforeEach(()=>{vi.stubGlobal("MediaStream",class extends EventTarget{private tracks:MediaStreamTrack[];constructor(tracks:MediaStreamTrack[]=[]){super();this.tracks=tracks;}getTracks(){return this.tracks;}getAudioTracks(){return this.tracks;}getVideoTracks(){return [];} });vi.spyOn(LocalAudioTrack.prototype,"checkForSilence").mockResolvedValue(false);});
describe("explicit app-owned LiveKit raw microphone capture",()=>{
 it("preserves SDK default voiceIsolation/default-device semantics and makes actual SDK ended handling mute instead of reacquire",async()=>{
  const raw=source(),gum=vi.fn(async()=>({getAudioTracks:()=>[raw],getTracks:()=>[raw]}));vi.stubGlobal("navigator",{...navigator,mediaDevices:{getUserMedia:gum}});
  const owned=await captureOwnedMicrophone(settings,()=>true);expect(owned.track.isUserProvided).toBe(true);expect(owned.source).toBe(raw);
  expect(gum).toHaveBeenCalledWith({audio:expect.objectContaining({deviceId:{exact:"selected"},voiceIsolation:true,echoCancellation:true,noiseSuppression:false,channelCount:1}),video:false});
  const restart=vi.spyOn(owned.track,"restartTrack");const room=new Room();
  const ended=Reflect.get(room.localParticipant,"handleTrackEnded")as(track:LocalAudioTrack)=>Promise<void>;
  await ended.call(room.localParticipant,owned.track);expect(owned.track.isMuted).toBe(true);expect(restart).not.toHaveBeenCalled();expect(gum).toHaveBeenCalledOnce();owned.track.stop();await room.disconnect();
 });
 it("never falls back implicitly and disposes a stale acquired raw source",async()=>{
  const raw=source();let current=true;const gum=vi.fn(async()=>{current=false;return{getAudioTracks:()=>[raw],getTracks:()=>[raw]};});vi.stubGlobal("navigator",{...navigator,mediaDevices:{getUserMedia:gum}});
  await expect(captureOwnedMicrophone(settings,()=>current)).rejects.toMatchObject({name:"AbortError"});expect(raw.stop).toHaveBeenCalledOnce();
  const denied=vi.fn().mockRejectedValue(new DOMException("denied","NotAllowedError"));vi.stubGlobal("navigator",{...navigator,mediaDevices:{getUserMedia:denied}});await expect(captureOwnedMicrophone(settings,()=>true)).rejects.toMatchObject({name:"NotAllowedError"});expect(denied).toHaveBeenCalledOnce();
 });
});
