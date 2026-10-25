import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {createPeerConnection} from "./p2pPeerConnection";
import {getP2PMediaController,registerP2PLocalSource} from "./p2pMediaController";
vi.mock("../api/clientLog",()=>({logToServer:vi.fn()}));
const peers:Peer[]=[];
class Track extends EventTarget{kind="audio";readyState="live"}
class Peer {
 signalingState="stable";connectionState="new";iceConnectionState="new";localDescription:RTCSessionDescriptionInit|null=null;
 ontrack:((event:RTCTrackEvent)=>void)|null=null;onicecandidate:((event:RTCPeerConnectionIceEvent)=>void)|null=null;onconnectionstatechange:(()=>void)|null=null;onnegotiationneeded:(()=>void)|null=null;
 transceivers=[{mid:null as string|null,currentDirection:"sendrecv",sender:{track:new Track()},receiver:{track:new Track()}}];
 constructor(){peers.push(this)}getSenders(){return this.transceivers.map(value=>value.sender)}getTransceivers(){return this.transceivers}
 createOffer=vi.fn(async()=>({type:"offer" as const,sdp:"v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendrecv\r\n"}));createAnswer=this.createOffer;
 setLocalDescription=vi.fn(async(value:RTCSessionDescriptionInit)=>{this.localDescription=value;this.signalingState=value.type==="offer"?"have-local-offer":"stable";this.transceivers[0].mid="0"});
 setRemoteDescription=vi.fn(async()=>{});
}
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve()};
beforeEach(()=>{peers.length=0;vi.stubGlobal("RTCPeerConnection",Peer)});afterEach(()=>{peers.forEach(peer=>getP2PMediaController(peer as unknown as RTCPeerConnection)?.dispose());vi.unstubAllGlobals();vi.useRealTimers()});
it("factory routes actual offer creation through SDP-bound sender classification",async()=>{
 const send=vi.fn();let current=true;const pc=createPeerConnection("call",send,{onRemoteMedia:vi.fn(),isCurrent:()=>current,isCaller:true,onTerminated:vi.fn()});
 registerP2PLocalSource(pc,pc.getSenders()[0],"microphone");pc.onnegotiationneeded?.(new Event("negotiationneeded"));await tick();expect(send.mock.lastCall![0]).toBe("p2p_signal");expect(send.mock.lastCall![1].sources).toEqual([{mid:"0",source:"microphone"}]);
 current=false;pc.onicecandidate?.({candidate:{toJSON:()=>({candidate:"old"})}} as RTCPeerConnectionIceEvent);expect(send).toHaveBeenCalledOnce();
});
it("a stale disconnect timer and disposed handlers cannot terminate a replacement PC",async()=>{
 vi.useFakeTimers();let current=true;const terminated=vi.fn(),pc=createPeerConnection("call",vi.fn(),{onRemoteMedia:vi.fn(),isCurrent:()=>current,isCaller:false,onTerminated:terminated});const fake=pc as unknown as Peer;fake.connectionState="disconnected";fake.onconnectionstatechange?.();current=false;await vi.advanceTimersByTimeAsync(5001);expect(terminated).not.toHaveBeenCalled();
 getP2PMediaController(pc)!.dispose();expect(fake.ontrack).toBeNull();expect(fake.onicecandidate).toBeNull();expect(fake.onnegotiationneeded).toBeNull();expect(fake.onconnectionstatechange).toBeNull();
});
