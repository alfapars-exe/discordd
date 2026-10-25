import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {useP2PCallStore} from "./p2pCallStore";
import {useAuthStore} from "./authStore";
import {setTokens} from "../api/client";
const h=vi.hoisted(()=>({picker:vi.fn(),native:false,cap:true,records:[] as Array<{options:{current:()=>boolean;state:(status:string)=>void};start:ReturnType<typeof vi.fn>;stop:ReturnType<typeof vi.fn>;raw:MediaStreamTrack|null}>}));
vi.mock("../utils/constants",async original=>({...await original<typeof import("../utils/constants")>(),isElectron:()=>h.native}));
vi.mock("../webrtc/p2pMediaController",()=>({registerP2PLocalSource:vi.fn(),getP2PMediaController:()=>({canSendScreenAudio:()=>h.cap,dispose:vi.fn(),getLocalSource:()=>null,setLocalSource:vi.fn(),waitUntilLocalSourceNegotiated:vi.fn()})}));
vi.mock("../webrtc/p2pScreenShare",()=>({startScreenShare:h.picker,stopScreenShare:vi.fn(async()=>true)}));
vi.mock("../webrtc/p2pScreenAudioSession",()=>({P2PScreenAudioSession:class{
 options;raw:MediaStreamTrack|null=null;start=vi.fn(async(value:{native:boolean;browserTrack:MediaStreamTrack|null})=>{this.raw=value.browserTrack;this.options.state("starting");return true});stop=vi.fn(()=>{if(this.raw){this.raw.enabled=false;this.raw.stop()}});
 constructor(options:{current:()=>boolean;state:(status:string)=>void}){this.options=options;h.records.push(this);options.state("starting")}
}}));
const raw=(kind="audio")=>Object.assign(new EventTarget(),{kind,enabled:kind!=="audio",readyState:"live",stop:vi.fn(),onended:null as (()=>void)|null}) as unknown as MediaStreamTrack;
function fixture(){const camera=raw("video"),sender={track:camera,replaceTrack:vi.fn(async()=>{})},pc={getSenders:()=>[sender],getReceivers:()=>[],close:vi.fn(),signalingState:"stable"};const stream={getTracks:()=>[camera],getVideoTracks:()=>[camera]};
 useP2PCallStore.setState({activeCall:{id:"call",caller_id:"owner",receiver_id:"peer",status:"active"} as never,peerConnection:pc as unknown as RTCPeerConnection,localStream:stream as unknown as MediaStream,peerScreenAudioSupported:true,isScreenSharing:false,isVideoOn:true});return{camera,sender,pc};}
function selected(video=raw("video"),audio:MediaStreamTrack|null=raw()){
 const dispose=vi.fn(()=>{video.stop();audio?.stop()});return{sender:{track:video},track:video,audioTrack:audio,update:vi.fn(async()=>true),dispose};
}
beforeEach(()=>{h.records=[];h.picker.mockReset();h.native=false;h.cap=true;setTokens("screen-test","","owner");useAuthStore.setState({user:{id:"owner"} as never})});
afterEach(()=>useP2PCallStore.getState().cleanup());
it("requests browser audio in the SAME picker only after explicit current capability choice",async()=>{
 fixture();const result=selected();h.picker.mockResolvedValue(result);useP2PCallStore.getState().setScreenAudioRequested(true);useP2PCallStore.getState().toggleScreenShare();await vi.waitFor(()=>expect(h.records).toHaveLength(1));
 expect(h.picker).toHaveBeenCalledOnce();expect(h.picker.mock.calls[0][1].audioRequested).toBe(true);expect(h.records[0].start).toHaveBeenCalledWith({native:false,browserTrack:result.audioTrack});expect(result.audioTrack!.enabled).toBe(false);expect(useP2PCallStore.getState().screenAudioStatus).toBe("starting");
 h.records[0].options.state("shared");expect(useP2PCallStore.getState().screenAudioStatus).toBe("shared");useP2PCallStore.getState().stopScreenAudio();expect(h.records[0].stop).toHaveBeenCalledOnce();expect(useP2PCallStore.getState().screenAudioRequested).toBe(false);expect(useP2PCallStore.getState().isScreenSharing).toBe(true);expect(result.track.stop).not.toHaveBeenCalled();
});
it("does not request or instantiate audio for legacy/unconfirmed peers",async()=>{fixture();h.cap=false;useP2PCallStore.setState({peerScreenAudioSupported:false});useP2PCallStore.getState().setScreenAudioRequested(true);expect(useP2PCallStore.getState().screenAudioRequested).toBe(false);h.picker.mockResolvedValue(selected(undefined,null));useP2PCallStore.getState().toggleScreenShare();await vi.waitFor(()=>expect(useP2PCallStore.getState().isScreenSharing).toBe(true));expect(h.picker.mock.calls[0][1].audioRequested).toBe(false);expect(h.records).toHaveLength(0)});
it("rejects pending-picker choice changes and explicit stop prevents late audio adoption",async()=>{
 fixture();let resolve!:(value:ReturnType<typeof selected>)=>void;h.picker.mockReturnValue(new Promise(done=>{resolve=done}));useP2PCallStore.getState().setScreenAudioRequested(true);useP2PCallStore.getState().toggleScreenShare();useP2PCallStore.getState().setScreenAudioRequested(false);expect(useP2PCallStore.getState().screenAudioRequested).toBe(true);useP2PCallStore.getState().stopScreenAudio();const result=selected();resolve(result);await vi.waitFor(()=>expect(useP2PCallStore.getState().isScreenSharing).toBe(true));expect(h.records).toHaveLength(0);expect(result.audioTrack!.stop).toHaveBeenCalled();expect(result.track.stop).not.toHaveBeenCalled();
});
it.each(["not_returned","unavailable","ended"])("keeps video truthful after audio-only %s and ignores stale callbacks",async status=>{
 fixture();h.picker.mockResolvedValue(selected());useP2PCallStore.getState().setScreenAudioRequested(true);useP2PCallStore.getState().toggleScreenShare();await vi.waitFor(()=>expect(h.records).toHaveLength(1));h.records[0].options.state(status);expect(useP2PCallStore.getState().screenAudioStatus).toBe(status);expect(useP2PCallStore.getState().screenAudioRequested).toBe(false);expect(useP2PCallStore.getState().isScreenSharing).toBe(true);h.records[0].options.state("shared");expect(useP2PCallStore.getState().screenAudioStatus).toBe(status);
});
it("synchronously retires audio on capability loss without stopping video or restarting on return",async()=>{
 fixture();const result=selected();h.picker.mockResolvedValue(result);useP2PCallStore.getState().setScreenAudioRequested(true);useP2PCallStore.getState().toggleScreenShare();await vi.waitFor(()=>expect(h.records).toHaveLength(1));h.records[0].options.state("shared");h.cap=false;useP2PCallStore.setState({peerScreenAudioSupported:false});expect(h.records[0].stop).toHaveBeenCalledOnce();expect(result.audioTrack!.enabled).toBe(false);expect(result.track.stop).not.toHaveBeenCalled();expect(useP2PCallStore.getState().screenAudioStatus).toBe("off");h.cap=true;useP2PCallStore.setState({peerScreenAudioSupported:true});expect(h.records).toHaveLength(1);expect(useP2PCallStore.getState().screenAudioRequested).toBe(false);
});
it("native sharing uses the same source scope and account retirement stops audio before late status",async()=>{
 fixture();h.native=true;const result=selected(undefined,null);h.picker.mockResolvedValue(result);useP2PCallStore.getState().setScreenAudioRequested(true);useP2PCallStore.getState().toggleScreenShare();await vi.waitFor(()=>expect(h.records).toHaveLength(1));expect(h.records[0].start).toHaveBeenCalledWith({native:true,browserTrack:null});setTokens("replacement","","other");h.records[0].options.state("shared");expect(h.records[0].stop).toHaveBeenCalled();expect(useP2PCallStore.getState().screenAudioStatus).toBe("off");expect(useP2PCallStore.getState().activeCall).toBeNull();
});

it("a retained audio-stop action cannot stop a later share on the same call",async()=>{
 fixture();h.picker.mockResolvedValueOnce(selected()).mockResolvedValueOnce(selected());useP2PCallStore.getState().setScreenAudioRequested(true);useP2PCallStore.getState().toggleScreenShare();await vi.waitFor(()=>expect(h.records).toHaveLength(1));const oldStop=useP2PCallStore.getState().stopScreenAudio;
 useP2PCallStore.getState().toggleScreenShare();await vi.waitFor(()=>expect(useP2PCallStore.getState().isScreenSharePending).toBe(false));useP2PCallStore.getState().setScreenAudioRequested(true);useP2PCallStore.getState().toggleScreenShare();await vi.waitFor(()=>expect(h.records).toHaveLength(2));h.records[1].options.state("shared");oldStop();expect(h.records[1].stop).not.toHaveBeenCalled();expect(useP2PCallStore.getState().screenAudioStatus).toBe("shared");
 useP2PCallStore.getState().stopScreenAudio();expect(h.records[1].stop).toHaveBeenCalledOnce();
});
it("a retained audio-stop action cannot stop a reauthenticated call",async()=>{
 fixture();h.picker.mockResolvedValue(selected());useP2PCallStore.getState().setScreenAudioRequested(true);useP2PCallStore.getState().toggleScreenShare();await vi.waitFor(()=>expect(h.records).toHaveLength(1));const oldStop=useP2PCallStore.getState().stopScreenAudio;
 setTokens("new-generation","","owner");fixture();useP2PCallStore.getState().setScreenAudioRequested(true);useP2PCallStore.getState().toggleScreenShare();await vi.waitFor(()=>expect(h.records).toHaveLength(2));h.records[1].options.state("shared");oldStop();expect(h.records[1].stop).not.toHaveBeenCalled();expect(useP2PCallStore.getState().screenAudioStatus).toBe("shared");
});

it("keeps cancelled-picker camera restoration authority exact and independent of audio-only revocation",async()=>{
 const f=fixture();let resolve!:(value:ReturnType<typeof selected>)=>void;h.picker.mockReturnValue(new Promise(done=>{resolve=done}));useP2PCallStore.getState().setScreenAudioRequested(true);useP2PCallStore.getState().toggleScreenShare();const options=h.picker.mock.calls[0][1];expect(options.restoreCurrent()).toBe(false);expect(useP2PCallStore.getState().isScreenSharePending).toBe(true);
 useP2PCallStore.getState().stopScreenAudio();expect(options.isCurrent()).toBe(true);expect(options.audioCurrent()).toBe(false);expect(options.restoreCurrent()).toBe(false);
 useP2PCallStore.getState().toggleScreenShare();expect(options.isCurrent()).toBe(false);expect(options.restoreCurrent()).toBe(true);expect(useP2PCallStore.getState().isScreenSharePending).toBe(false);
 h.picker.mockResolvedValueOnce(selected());useP2PCallStore.getState().toggleScreenShare();expect(options.restoreCurrent()).toBe(false);useP2PCallStore.setState({peerConnection:{...f.pc} as unknown as RTCPeerConnection});expect(options.restoreCurrent()).toBe(false);resolve(selected());
});
