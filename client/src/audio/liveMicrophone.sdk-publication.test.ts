import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {LocalAudioTrack,type LocalParticipant} from "livekit-client";
import {liveMicrophone,releaseLiveMicrophone} from "./liveMicrophone";
import {registerCaptureAdmission} from "./microphoneAdmission";
import {getActiveCallPipeline} from "./pipelineStatus";
import {publishAuthOwnerChange,publishAuthGenerationChange} from "../api/authSessionEvents";
const h=vi.hoisted(()=>({createPipeline:vi.fn(),state:{inputDevice:"",micProfile:"konusma",noiseReduction:true,noiseReductionEngine:"rnnoise",noiseSuppressionLevel:"medium",micSensitivity:50,inputVolume:100,deepfilterSuppression:70,isDeafened:false}}));
vi.mock("./microphonePipeline",()=>({createMicrophonePipeline:h.createPipeline}));
vi.mock("../stores/voiceStore",()=>({useVoiceStore:{getState:()=>h.state,subscribe:()=>()=>{}}}));
let contexts=0;
const raw=()=>Object.assign(new EventTarget(),{id:crypto.randomUUID(),kind:"audio",readyState:"live",enabled:true,muted:false,getSettings:()=>({}),getConstraints:()=>({}),stop:vi.fn(),applyConstraints:vi.fn(async()=>{})}) as unknown as MediaStreamTrack;
beforeEach(()=>{
 contexts=0;publishAuthOwnerChange("owner");publishAuthGenerationChange(101);
 vi.stubGlobal("MediaStream",class extends EventTarget{private tracks:MediaStreamTrack[];constructor(tracks:MediaStreamTrack[]=[]){super();this.tracks=tracks}getTracks(){return this.tracks}getAudioTracks(){return this.tracks}getVideoTracks(){return []}addTrack(track:MediaStreamTrack){this.tracks.push(track)}removeTrack(track:MediaStreamTrack){this.tracks=this.tracks.filter(t=>t!==track)}});
 vi.stubGlobal("AudioContext",class{constructor(){if(++contexts>8)throw new Error("QA bounded context recreation limit")}state="running";close=vi.fn(async()=>{});createMediaStreamSource(){return{connect:vi.fn(),disconnect:vi.fn()}}createAnalyser(){return{fftSize:32,connect:vi.fn(),disconnect:vi.fn(),getByteTimeDomainData:vi.fn()}}});
 vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue();vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{});vi.spyOn(LocalAudioTrack.prototype,"checkForSilence").mockResolvedValue(false);
 vi.stubGlobal("navigator",{...navigator,mediaDevices:{getUserMedia:vi.fn(async()=>{const track=raw();return{getAudioTracks:()=>[track],getTracks:()=>[track]}})}});
 h.createPipeline.mockReset().mockImplementation(async()=>({processedTrack:raw(),update:vi.fn(async()=>{}),dispose:vi.fn(async()=>{}),getStatus:()=>({phase:"ready",activeEngine:"rnnoise"}),subscribe:()=>()=>{}}));
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()});
it("settles actual SDK processor publication superseded by duplicate enable without retaining a destroyed graph",async()=>{
 let finish!:()=>void;const pending=new Promise<void>(resolve=>{finish=resolve});
 const publications=new Map<LocalAudioTrack,unknown>();
 const participant={getTrackPublication:vi.fn(),publishTrack:vi.fn(async(track:LocalAudioTrack)=>{publications.set(track,{});if(publications.size===1)await pending;return{track}}),unpublishTrack:vi.fn(async(track:LocalAudioTrack)=>{publications.delete(track)})} as unknown as LocalParticipant;
 const lease=registerCaptureAdmission(participant,()=>true);lease.open();const controller=liveMicrophone(participant,"private");
 try{
  const first=controller.setEnabled(true);
  await vi.waitFor(()=>expect(participant.publishTrack).toHaveBeenCalledOnce());
  expect(getActiveCallPipeline()).toBeNull();
  const second=controller.setEnabled(true);finish();await Promise.all([first,second]);
  expect(controller.getStatus().phase).toBe("ready");expect(getActiveCallPipeline()).not.toBeNull();
  expect(publications.size).toBe(1);expect(participant.publishTrack).toHaveBeenCalledTimes(2);
 }finally{finish?.();await releaseLiveMicrophone(participant);lease.retire()}
 expect(getActiveCallPipeline()).toBeNull();
});

it("keeps actual SDK publish-time valid context adoption bounded and the processed graph registered",async()=>{
 const roomContext=new AudioContext();
 const participant={getTrackPublication:vi.fn(),publishTrack:vi.fn(async(track:LocalAudioTrack)=>{await track.setAudioContext(roomContext);return{track}}),unpublishTrack:vi.fn(async()=>{})} as unknown as LocalParticipant;
 const lease=registerCaptureAdmission(participant,()=>true);lease.open();const controller=liveMicrophone(participant,"private");
 try{
  await controller.setEnabled(true);
  for(let i=0;i<20;i++)await Promise.resolve();
  expect(controller.getStatus().phase).toBe("ready");
  expect(contexts).toBe(3); // room, initial graph, one SDK-driven graph restart
  expect(h.createPipeline).toHaveBeenCalledTimes(2);
  expect(getActiveCallPipeline()).not.toBeNull();
 }finally{await releaseLiveMicrophone(participant);lease.retire();await roomContext.close()}
});
