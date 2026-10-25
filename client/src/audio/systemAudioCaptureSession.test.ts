import {afterEach,beforeEach,expect,it,vi}from "vitest";
import {SystemAudioCaptureSession,systemAudioWorkletURL,type SystemAudioState}from "./systemAudioCaptureSession";
import {publishAuthOwnerChange,publishAuthGenerationChange}from "../api/authSessionEvents";
type CaptureEvent={leaseId:string;type:"header"|"data"|"error"|"stopped";value?:unknown};
const header={sampleRate:48000,channels:2,bitsPerSample:32,formatTag:3};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
let listeners:Set<(event:CaptureEvent)=>void>,reserve:ReturnType<typeof vi.fn>,start:ReturnType<typeof vi.fn>,release:ReturnType<typeof vi.fn>,contexts:Array<{close:ReturnType<typeof vi.fn>;track:{enabled:boolean;stop:ReturnType<typeof vi.fn>};addModule:ReturnType<typeof vi.fn>;resume:ReturnType<typeof vi.fn>}>,nodes:Array<{port:{postMessage:ReturnType<typeof vi.fn>;onmessage:((event:{data:unknown})=>void)|null};disconnect:ReturnType<typeof vi.fn>}>;
const all:SystemAudioCaptureSession[]=[];let nextModule:Promise<void>|null=null;let nextResume:Promise<void>|null=null;
function emit(leaseId:string,type:CaptureEvent["type"],value?:unknown){for(const cb of [...listeners])cb({leaseId,type,value});}
beforeEach(()=>{publishAuthOwnerChange("owner");publishAuthGenerationChange(1);listeners=new Set();nextModule=null;nextResume=null;let id=0;reserve=vi.fn(async()=>`lease${++id}`);start=vi.fn(async()=>{});release=vi.fn(async()=>true);contexts=[];nodes=[];window.electronAPI={reserveSystemCaptureLease:reserve,startSystemCaptureLease:start,releaseSystemCaptureLease:release,onSystemCaptureLeaseEvent:(cb:(event:CaptureEvent)=>void)=>{listeners.add(cb);return()=>{listeners.delete(cb);};}}as unknown as Window["electronAPI"];
 vi.stubGlobal("AudioContext",class{state="running";track={enabled:true,readyState:"live",addEventListener:vi.fn(),removeEventListener:vi.fn(),stop:vi.fn()};audioWorklet={addModule:vi.fn(()=>{const pending=nextModule;nextModule=null;return pending??Promise.resolve();})};close=vi.fn(async()=>{});resume=vi.fn(()=>{const pending=nextResume;nextResume=null;return pending??Promise.resolve();});createMediaStreamDestination=()=>({stream:{getAudioTracks:()=>[this.track]},disconnect:vi.fn()});constructor(){contexts.push({close:this.close,track:this.track,addModule:this.audioWorklet.addModule,resume:this.resume});}});
 vi.stubGlobal("AudioWorkletNode",class{port={postMessage:vi.fn(),onmessage:null};disconnect=vi.fn();connect=vi.fn();constructor(){nodes.push(this);}});
});
afterEach(()=>{for(const source of all)source.stop();all.length=0;window.electronAPI=undefined;vi.unstubAllGlobals();vi.useRealTimers();});
function source(current:()=>boolean=()=>true){const states:SystemAudioState[]=[];const owner=new SystemAudioCaptureSession({kind:"group",source:crypto.randomUUID(),current,state:s=>states.push(s)});all.push(owner);return{owner,states};}
it("subscribes before native start, accepts an immediate header and returns a disabled track only after context resume",async()=>{
 start.mockImplementation(async(id:string)=>{emit(id,"header",header);});const f=source(),track=await f.owner.start();expect(start).toHaveBeenCalledWith("lease1");expect(track.enabled).toBe(false);expect(f.states.at(-1)?.phase).toBe("ready");expect(contexts[0].resume).toHaveBeenCalledOnce();f.owner.stop();expect(release).toHaveBeenCalledWith("lease1");expect(contexts[0].track.stop).toHaveBeenCalledOnce();
});
it("late reservation after auth retirement is released without starting capture",async()=>{
 const pending=deferred<string>();reserve.mockReturnValue(pending.promise);const f=source(),ready=f.owner.start().catch(error=>error);publishAuthGenerationChange(2);pending.resolve("late");await ready;await Promise.resolve();expect(release).toHaveBeenCalledWith("late");expect(start).not.toHaveBeenCalled();expect(contexts).toHaveLength(0);expect(listeners.size).toBe(0);
});
it("deferred worklet setup after stop cannot create a graph or affect the next lease",async()=>{
 const module=deferred<void>();nextModule=module.promise;const first=source(),pending=first.owner.start().catch(error=>error);await Promise.resolve();emit("lease1","header",header);expect(contexts).toHaveLength(1);expect(nodes).toHaveLength(0);
 first.owner.stop();await pending;expect(contexts[0].close).toHaveBeenCalledOnce();const second=source(),ready=second.owner.start();await Promise.resolve();emit("lease2","header",header);await ready;const current=contexts[1];emit("lease1","stopped");emit("lease1","data",new Uint8Array(8));module.resolve();await Promise.resolve();expect(nodes).toHaveLength(1);expect(current.close).not.toHaveBeenCalled();expect(current.track.stop).not.toHaveBeenCalled();expect(second.states.at(-1)?.phase).toBe("ready");expect(first.states.at(-1)?.phase).toBe("idle");second.owner.stop();
});
it("busy reservation failure does not stop an already active source",async()=>{
 const first=source(),ready=first.owner.start();await Promise.resolve();emit("lease1","header",header);await ready;reserve.mockRejectedValueOnce(new Error("already in use"));const second=source();await expect(second.owner.start()).rejects.toThrow("capture_unavailable");expect(release).not.toHaveBeenCalled();expect(contexts[0].track.stop).not.toHaveBeenCalled();expect(first.states.at(-1)?.phase).toBe("ready");
});
it("decodes integer PCM with arbitrary byte offsets and bounds worklet backlog",async()=>{
 const f=source(),ready=f.owner.start();await Promise.resolve();emit("lease1","header",{...header,bitsPerSample:16,formatTag:1});await ready;const bytes=new Uint8Array(5),view=new DataView(bytes.buffer);view.setInt16(1,-32768,true);view.setInt16(3,16384,true);emit("lease1","data",bytes.subarray(1));expect(Array.from(nodes[0].port.postMessage.mock.calls[0][0]as Float32Array)).toEqual([-1,0.5]);for(let i=0;i<100;i++)emit("lease1","data",bytes.subarray(1));expect(nodes[0].port.postMessage).toHaveBeenCalledTimes(17);nodes[0].port.onmessage?.({data:"processed"});emit("lease1","data",bytes.subarray(1));expect(nodes[0].port.postMessage).toHaveBeenCalledTimes(18);
});
it("invalid format and helper stop surface failure and retire only the owning lease",async()=>{
 const f=source(),ready=f.owner.start().catch(error=>error);await Promise.resolve();emit("lease1","header",{...header,sampleRate:1});await ready;expect(f.states.at(-1)).toEqual({phase:"failed",reason:"invalid_audio_format"});expect(release).toHaveBeenCalledWith("lease1");expect(listeners.size).toBe(0);
});

it("silent ended destination during deferred resume is failure, never a ready audio track",async()=>{
 const gate=deferred<void>();nextResume=gate.promise;const f=source(),ready=f.owner.start().catch(error=>error);await Promise.resolve();emit("lease1","header",header);await vi.waitFor(()=>expect(contexts[0].resume).toHaveBeenCalled());Object.assign(contexts[0].track,{readyState:"ended"});gate.resolve();await ready;expect(f.states.at(-1)).toEqual({phase:"failed",reason:"audio_track_ended"});expect(f.states.some(state=>state.phase==="ready")).toBe(false);expect(contexts[0].track.stop).toHaveBeenCalledOnce();
});
it("autoplay/context resume rejection tears down raw output and does not claim active capture",async()=>{
 nextResume=Promise.reject(new DOMException("denied","NotAllowedError"));const f=source(),ready=f.owner.start().catch(error=>error);await Promise.resolve();emit("lease1","header",header);await ready;expect(f.states.at(-1)).toEqual({phase:"failed",reason:"worklet_setup"});expect(contexts[0].track.stop).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledWith("lease1");expect(listeners.size).toBe(0);
});

it.each(["stop","auth"])("a source retired by %s before start rejects promptly without native access",async(reason)=>{
 const f=source();if(reason==="stop")f.owner.stop();else publishAuthGenerationChange(2);await expect(f.owner.start()).rejects.toMatchObject({name:"AbortError"});expect(reserve).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled();
});
it("synchronous source-subscription retirement does not leak its returned listener or hang start",async()=>{
 const cleanup=vi.fn();const source=new SystemAudioCaptureSession({kind:"group",source:"synchronous",current:()=>false,subscribeCurrent:retire=>{retire();return cleanup;}});all.push(source);expect(cleanup).toHaveBeenCalledOnce();await expect(source.start()).rejects.toMatchObject({name:"AbortError"});expect(reserve).not.toHaveBeenCalled();
});
it("resolves packaged file/app hash routes beside the bundle and web deep routes at origin root",()=>{
 expect(systemAudioWorkletURL("file:///C:/Program%20Files/HiChat/resources/app.asar/client/dist/index.html#/channels/id",true,"./")).toBe("file:///C:/Program%20Files/HiChat/resources/app.asar/client/dist/pcm-feeder-processor.js");
 expect(systemAudioWorkletURL("app://hichat/index.html#/settings",true,"./")).toBe("app://hichat/pcm-feeder-processor.js");
 expect(systemAudioWorkletURL("https://hichat.test/channels/server/channel",false,"./")).toBe("https://hichat.test/pcm-feeder-processor.js");
});
