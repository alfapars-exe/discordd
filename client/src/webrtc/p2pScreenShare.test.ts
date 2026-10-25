import {beforeEach,expect,it,vi} from "vitest";
import {startScreenShare} from "./p2pScreenShare";
const capture=vi.fn();
function track(){return{kind:"video",enabled:true,readyState:"live",stop:vi.fn(),applyConstraints:vi.fn().mockResolvedValue(undefined)} as unknown as MediaStreamTrack;}
function fixture(){const camera=track();const sender={track:camera,getParameters:()=>({encodings:[{}]}),setParameters:vi.fn().mockResolvedValue(undefined),replaceTrack:vi.fn(async(next:MediaStreamTrack)=>{sender.track=next;})};const pc={signalingState:"stable",getSenders:()=>[sender]};return{sender,pc:pc as unknown as RTCPeerConnection};}
beforeEach(()=>{capture.mockReset();Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getDisplayMedia:capture}});});
it("publishes the selected quality and updates the existing source without reopening the picker",async()=>{
 const screen=track(),{pc,sender}=fixture();capture.mockResolvedValue({getVideoTracks:()=>[screen],getTracks:()=>[screen]});
 const result=await startScreenShare(pc,{isCurrent:()=>true,settings:{screenShareQuality:"1440p",screenShareFps:120}});
 expect(capture).toHaveBeenCalledWith({audio:false,video:{width:{ideal:2560},height:{ideal:1440},frameRate:{ideal:120,max:120}}});
 expect(screen.enabled).toBe(true);await result!.update({screenShareQuality:"720p",screenShareFps:30});
 expect(screen.applyConstraints).toHaveBeenLastCalledWith({width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}});
 expect(sender.setParameters).toHaveBeenLastCalledWith({encodings:[{maxFramerate:30,maxBitrate:1500000}]});expect(capture).toHaveBeenCalledOnce();
});
it("stops a late picker result and never replaces the sender after account/call retirement",async()=>{
 let resolve!:(value:unknown)=>void;capture.mockReturnValue(new Promise(done=>{resolve=done;}));let current=true;
 const screen=track(),{pc,sender}=fixture();const pending=startScreenShare(pc,{isCurrent:()=>current,settings:{screenShareQuality:"1080p",screenShareFps:60}});
 current=false;resolve({getVideoTracks:()=>[screen],getTracks:()=>[screen]});expect(await pending).toBeNull();expect(screen.stop).toHaveBeenCalledOnce();expect(sender.replaceTrack).not.toHaveBeenCalled();
});
it("keeps pending replacement disabled and retires it if the source lease changes during replaceTrack",async()=>{
 const screen=track(),{pc,sender}=fixture();let finish!:()=>void;let current=true;
 sender.replaceTrack.mockImplementation(async next=>{sender.track=next;await new Promise<void>(done=>{finish=done;});});capture.mockResolvedValue({getVideoTracks:()=>[screen],getTracks:()=>[screen]});
 const pending=startScreenShare(pc,{isCurrent:()=>current,settings:{screenShareQuality:"720p",screenShareFps:30}});await vi.waitFor(()=>expect(sender.replaceTrack).toHaveBeenCalled());expect(screen.enabled).toBe(false);current=false;finish();expect(await pending).toBeNull();expect(screen.enabled).toBe(false);expect(screen.stop).toHaveBeenCalledOnce();
});
it("does not update a retired source after constraints resolve",async()=>{
 const screen=track(),{pc,sender}=fixture();let current=true;capture.mockResolvedValue({getVideoTracks:()=>[screen],getTracks:()=>[screen]});const result=await startScreenShare(pc,{isCurrent:()=>current,settings:{screenShareQuality:"720p",screenShareFps:30}});
 let finish!:()=>void;vi.mocked(screen.applyConstraints).mockImplementationOnce(()=>new Promise<void>(done=>{finish=done;}));const count=sender.setParameters.mock.calls.length;
 const update=result!.update({screenShareQuality:"1440p",screenShareFps:120});current=false;finish();expect(await update).toBe(false);expect(sender.setParameters.mock.calls.length).toBe(count);
});
it("bounds missing renegotiation and releases its captured source",async()=>{
 vi.useFakeTimers();try{const raw=track(),sender={track:null,replaceTrack:vi.fn(),getParameters:()=>({encodings:[{}]}),setParameters:vi.fn()};const pc={signalingState:"stable",getSenders:()=>[],addTransceiver:()=>({sender})} as unknown as RTCPeerConnection;capture.mockResolvedValue({getVideoTracks:()=>[raw],getTracks:()=>[raw]});const result=startScreenShare(pc,{isCurrent:()=>true,settings:{screenShareQuality:"720p",screenShareFps:30}});const assertion=expect(result).rejects.toMatchObject({name:"AbortError"});await vi.advanceTimersByTimeAsync(10_100);await assertion;expect(raw.stop).toHaveBeenCalledOnce();expect(sender.replaceTrack).not.toHaveBeenCalled();}finally{vi.useRealTimers();}
});
it("resolves native Windows display metrics after picking without another capture",async()=>{
 const raw=track(),{pc}=fixture();capture.mockResolvedValue({getVideoTracks:()=>[raw],getTracks:()=>[raw]});const result=await startScreenShare(pc,{isCurrent:()=>true,settings:{screenShareQuality:"native",screenShareFps:-1},getDisplayMetrics:async()=>({width:3840,height:2160,refreshRate:144})});expect(result).toBeTruthy();expect(raw.applyConstraints).toHaveBeenCalledWith({width:{ideal:3840},height:{ideal:2160},frameRate:{ideal:144,max:144}});expect(capture).toHaveBeenCalledOnce();
});
it("reuses a negotiated video transceiver whose prior share was cleared",async()=>{
 const raw=track(),sender={track:null as MediaStreamTrack|null,getParameters:()=>({encodings:[{}]}),setParameters:vi.fn().mockResolvedValue(undefined),replaceTrack:vi.fn(async(next:MediaStreamTrack)=>{sender.track=next;})};const pc={signalingState:"stable",getSenders:()=>[sender],getTransceivers:()=>[{sender,receiver:{track:{kind:"video"}},currentDirection:"sendrecv",stopped:false}],addTransceiver:vi.fn()} as unknown as RTCPeerConnection;capture.mockResolvedValue({getVideoTracks:()=>[raw],getTracks:()=>[raw]});expect(await startScreenShare(pc,{isCurrent:()=>true,settings:{screenShareQuality:"720p",screenShareFps:30}})).toBeTruthy();expect(pc.addTransceiver).not.toHaveBeenCalled();
});
it("restores the camera and stops screen capture if initial quality application fails",async()=>{
 const raw=track(),{pc,sender}=fixture(),camera=sender.track;vi.mocked(raw.applyConstraints).mockRejectedValueOnce(new Error("unsupported constraints"));capture.mockResolvedValue({getVideoTracks:()=>[raw],getTracks:()=>[raw]});await expect(startScreenShare(pc,{isCurrent:()=>true,settings:{screenShareQuality:"1440p",screenShareFps:120}})).rejects.toThrow("unsupported constraints");expect(sender.track).toBe(camera);expect(raw.stop).toHaveBeenCalledOnce();expect(raw.enabled).toBe(false);
});
