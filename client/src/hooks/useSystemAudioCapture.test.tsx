import {act,renderHook}from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi}from "vitest";
import {useSystemAudioCapture}from "./useSystemAudioCapture";
vi.mock("../utils/constants",()=>({isElectron:()=>true,isNativeApp:()=>true}));
const h=vi.hoisted(()=>({toast:vi.fn(),syncRetire:false}));vi.mock("../stores/toastStore",()=>({useToastStore:{getState:()=>({addToast:h.toast})}}));
vi.mock("../audio/microphoneAdmission",()=>({captureAdmissionCurrent:()=>false,subscribeCaptureAdmission:(_participant:unknown,retire:()=>void)=>{if(h.syncRetire)retire();return()=>{};}}));
type Event={leaseId:string;type:"header"|"data"|"stopped"|"error";value?:unknown};
let listeners:Set<(value:Event)=>void>,api:{reserveSystemCaptureLease:ReturnType<typeof vi.fn>;startSystemCaptureLease:ReturnType<typeof vi.fn>;releaseSystemCaptureLease:ReturnType<typeof vi.fn>;onSystemCaptureLeaseEvent:(cb:(value:Event)=>void)=>()=>void;removeCaptureListeners:ReturnType<typeof vi.fn>};
const emit=(type:Event["type"],value?:unknown)=>{for(const listener of [...listeners])listener({leaseId:"lease",type,value});};
beforeEach(()=>{h.toast.mockClear();h.syncRetire=false;listeners=new Set();api={reserveSystemCaptureLease:vi.fn(async()=>"lease"),startSystemCaptureLease:vi.fn(async()=>{}),releaseSystemCaptureLease:vi.fn(async()=>true),onSystemCaptureLeaseEvent:cb=>{listeners.add(cb);return()=>{listeners.delete(cb);};},removeCaptureListeners:vi.fn()};window.electronAPI=api as unknown as Window["electronAPI"];});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();window.electronAPI=undefined;});
it("timeouts release only the exact lease and never erase another owner's listeners",async()=>{
 vi.useFakeTimers();const{result}=renderHook(()=>useSystemAudioCapture());let pending!:Promise<MediaStreamTrack|null>;act(()=>{pending=result.current.start();});await act(async()=>{});expect(api.startSystemCaptureLease).toHaveBeenCalledWith("lease");await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(await pending).toBeNull();expect(api.releaseSystemCaptureLease).toHaveBeenCalledWith("lease");expect(api.removeCaptureListeners).not.toHaveBeenCalled();expect(listeners.size).toBe(0);expect(result.current.isCapturing).toBe(false);expect(h.toast).toHaveBeenCalledOnce();
});
it("uses the same unaligned PCM conversion and closes ready capture on exact helper stop",async()=>{
 const track={enabled:true,readyState:"live",addEventListener:vi.fn(),removeEventListener:vi.fn(),stop:vi.fn()},context={state:"running",audioWorklet:{addModule:vi.fn(async()=>{})},resume:vi.fn(async()=>{}),createMediaStreamDestination:()=>({stream:{getAudioTracks:()=>[track]},disconnect:vi.fn()}),close:vi.fn(async()=>{})},worklet={port:{postMessage:vi.fn(),onmessage:null},connect:vi.fn(),disconnect:vi.fn()};
 vi.stubGlobal("AudioContext",class{state=context.state;audioWorklet=context.audioWorklet;resume=context.resume;createMediaStreamDestination=context.createMediaStreamDestination;close=context.close;});vi.stubGlobal("AudioWorkletNode",class{port=worklet.port;connect=worklet.connect;disconnect=worklet.disconnect;});
 const{result}=renderHook(()=>useSystemAudioCapture());let pending!:Promise<MediaStreamTrack|null>;act(()=>{pending=result.current.start();});await act(async()=>{});await act(async()=>{emit("header",{sampleRate:48000,channels:2,bitsPerSample:32,formatTag:3});await pending;});expect(await pending).toBe(track);expect(result.current.isCapturing).toBe(true);expect(track.enabled).toBe(false);
 const bytes=new Uint8Array(9),view=new DataView(bytes.buffer);view.setFloat32(1,0.25,true);view.setFloat32(5,-0.5,true);act(()=>emit("data",bytes.subarray(1)));expect(Array.from(worklet.port.postMessage.mock.calls[0][0]as Float32Array)).toEqual([0.25,-0.5]);act(()=>emit("stopped"));expect(result.current.isCapturing).toBe(false);expect(track.stop).toHaveBeenCalledOnce();expect(context.close).toHaveBeenCalledOnce();expect(api.releaseSystemCaptureLease).toHaveBeenCalledWith("lease");expect(api.removeCaptureListeners).not.toHaveBeenCalled();
});

it("synchronous admission retirement during construction returns null without native access or TDZ",async()=>{
 h.syncRetire=true;const participant={}as import("livekit-client").LocalParticipant;const{result}=renderHook(()=>useSystemAudioCapture(participant));let value:MediaStreamTrack|null|undefined;await act(async()=>{value=await result.current.start();});expect(value).toBeNull();expect(api.reserveSystemCaptureLease).not.toHaveBeenCalled();expect(api.startSystemCaptureLease).not.toHaveBeenCalled();expect(api.releaseSystemCaptureLease).not.toHaveBeenCalled();expect(result.current.isCapturing).toBe(false);expect(h.toast).not.toHaveBeenCalled();
});
