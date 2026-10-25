import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {P2PMediaController,registerP2PLocalSource} from "./p2pMediaController";
import type {P2PSignalPayload} from "../types/p2p";
const fixtures:P2PMediaController[]=[];
class Track extends EventTarget{kind="audio";readyState="live";label="screen microphone misleading";stop=vi.fn()}
class Stream{tracks:MediaStreamTrack[];constructor(tracks:MediaStreamTrack[]=[]){this.tracks=tracks}getTracks(){return this.tracks}}
const sdp=()=>"v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendrecv\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:1\r\na=sendrecv\r\n";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const offer=(revision=1):P2PSignalPayload=>({call_id:"call",type:"offer",sdp:sdp(),media_protocol:1,description_id:id(revision),description_revision:revision,capabilities:["screen-audio-v1"],sources:[{mid:"0",source:"microphone"},{mid:"1",source:"screen-audio"}]});
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve()};
function fixture(caller=false){
 let current=true;const tracks=[new Track(),new Track()],transceivers=tracks.map((track,index)=>({mid:String(index),sender:{track:new Track()},receiver:{track},currentDirection:"sendrecv"}));
 const pc={signalingState:"stable",localDescription:null as RTCSessionDescriptionInit|null,remoteDescription:null as RTCSessionDescriptionInit|null,getTransceivers:()=>transceivers,getSenders:()=>transceivers.map(value=>value.sender),createOffer:vi.fn(async()=>({type:"offer" as const,sdp:sdp()})),createAnswer:vi.fn(async()=>({type:"answer" as const,sdp:sdp()})),setLocalDescription:vi.fn(async(value:RTCSessionDescriptionInit)=>{pc.localDescription=value;pc.signalingState=value.type==="offer"?"have-local-offer":"stable"}),setRemoteDescription:vi.fn(async(value:RTCSessionDescriptionInit)=>{pc.remoteDescription=value;pc.signalingState=value.type==="offer"?"have-remote-offer":"stable";for(const transceiver of [...transceivers].reverse())controller.onTrack({track:transceiver.receiver.track,transceiver} as unknown as RTCTrackEvent)})};
 const send=vi.fn(),onMedia=vi.fn(),onError=vi.fn(),controller=new P2PMediaController(pc as unknown as RTCPeerConnection,{callId:"call",polite:!caller,isCaller:caller,isCurrent:()=>current,send,onMedia,onError});fixtures.push(controller);return{pc,controller,tracks,transceivers,send,onMedia,onError,retire:()=>{current=false}};
}
beforeEach(()=>{vi.stubGlobal("MediaStream",Stream)});afterEach(()=>{fixtures.splice(0).forEach(controller=>controller.dispose());vi.unstubAllGlobals();vi.useRealTimers()});
it("stages out-of-order tracks until accepted SDP then separates by MID not label",async()=>{
 const h=fixture();let complete!:()=>void;const original=h.pc.setRemoteDescription.getMockImplementation()!;h.pc.setRemoteDescription.mockImplementationOnce(async description=>{await original(description);await new Promise<void>(resolve=>{complete=resolve})});
 const applying=h.controller.applyRemoteDescription(offer());await tick();expect(h.onMedia).not.toHaveBeenCalled();complete();expect(await applying).toBe("accepted");const media=h.onMedia.mock.lastCall![0];expect(media.microphone.getTracks()).toEqual([h.tracks[0]]);expect(media.screenAudio.getTracks()).toEqual([h.tracks[1]]);expect(media.video).toBeNull();expect(h.controller.canSendScreenAudio()).toBe(true);expect(h.send.mock.lastCall![1].reply_to_description_id).toBe(id(1));
});
it("legacy chooses first SDP audio even if the second track arrives first and answers legacy",async()=>{const h=fixture();await h.controller.applyRemoteDescription({call_id:"call",type:"offer",sdp:sdp()});const media=h.onMedia.mock.lastCall![0];expect(media.microphone.getTracks()).toEqual([h.tracks[0]]);expect(media.screenAudio).toBeNull();expect(h.controller.canSendScreenAudio()).toBe(false);expect(h.send.mock.lastCall![1].media_protocol).toBeUndefined()});
it("ignores stale revisions/downgrade and rejects malformed sources preserving accepted leases",async()=>{const h=fixture();await h.controller.applyRemoteDescription(offer(2));const prior=h.onMedia.mock.lastCall![0];expect(await h.controller.applyRemoteDescription(offer(1))).toBe("ignored");expect(await h.controller.applyRemoteDescription({call_id:"call",type:"offer",sdp:sdp()})).toBe("ignored");await expect(h.controller.applyRemoteDescription({...offer(3),sources:[{mid:"0",source:"camera"}]})).rejects.toThrow();expect(h.onMedia.mock.lastCall![0]).toBe(prior)});
it("preserves accepted tracks when a failed SDP emits provisional tracks",async()=>{const h=fixture();await h.controller.applyRemoteDescription(offer());const prior=h.onMedia.mock.lastCall![0],provisional=new Track();h.transceivers[0].receiver.track=provisional;h.pc.setRemoteDescription.mockImplementationOnce(async()=>{h.controller.onTrack({track:provisional,transceiver:h.transceivers[0]} as unknown as RTCTrackEvent);throw new Error("SDP failure")});await expect(h.controller.applyRemoteDescription(offer(2))).rejects.toThrow();expect(h.onMedia.mock.lastCall![0]).toBe(prior);expect(provisional.stop).not.toHaveBeenCalled()});
it("reclassifies only after fresh SDP and revokes screen capability atomically",async()=>{const h=fixture();await h.controller.applyRemoteDescription(offer());await h.controller.applyRemoteDescription({...offer(2),sources:[{mid:"1",source:"microphone"}],capabilities:[]});const media=h.onMedia.mock.lastCall![0];expect(media.microphone.getTracks()).toEqual([h.tracks[1]]);expect(media.screenAudio).toBeNull();expect(media.screenAudioSupported).toBe(false);h.tracks[1].readyState="ended";h.tracks[1].dispatchEvent(new Event("ended"));expect(h.onMedia.mock.lastCall![0].microphone).toBeNull()});
it("signals actual sender mappings and accepts only its outstanding offer answer",async()=>{const h=fixture(true);registerP2PLocalSource(h.pc as unknown as RTCPeerConnection,h.transceivers[0].sender as unknown as RTCRtpSender,"microphone");await tick();const sent=h.send.mock.lastCall![1];expect(sent.sources).toEqual([{mid:"0",source:"microphone"}]);expect(await h.controller.applyRemoteDescription({...offer(4),type:"answer",reply_to_description_id:id(999)})).toBe("ignored");expect(h.pc.setRemoteDescription).not.toHaveBeenCalled();expect(await h.controller.applyRemoteDescription({...offer(5),type:"answer",reply_to_description_id:sent.description_id})).toBe("accepted");expect(await h.controller.applyRemoteDescription({...offer(6),type:"answer",reply_to_description_id:sent.description_id})).toBe("ignored")});
it("uses real glare roles: caller ignores and polite callee rolls back retiring its old offer",async()=>{const h=fixture(true);h.controller.requestNegotiation();await tick();expect(await h.controller.applyRemoteDescription(offer(10))).toBe("ignored");expect(h.pc.setRemoteDescription).not.toHaveBeenCalled();const p=fixture();await p.controller.applyRemoteDescription(offer());p.controller.requestNegotiation();await tick();const old=p.send.mock.lastCall![1].description_id;expect(await p.controller.applyRemoteDescription(offer(2))).toBe("accepted");expect(p.pc.setLocalDescription).toHaveBeenCalledWith({type:"rollback"});expect(p.send.mock.lastCall![1].reply_to_description_id).toBe(id(2));expect(await p.controller.applyRemoteDescription({...offer(3),type:"answer",reply_to_description_id:old})).toBe("ignored")});
it("cannot publish staged tracks or answer after auth/PC ownership retires",async()=>{const h=fixture();let release!:()=>void;h.pc.setRemoteDescription.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve})});const applying=h.controller.applyRemoteDescription(offer());await tick();h.retire();release();expect(await applying).toBe("ignored");expect(h.onMedia).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();h.controller.dispose()});

it("keeps a local source disabled until the exact offer is answered with negotiated sending direction",async()=>{
 const h=fixture();await h.controller.applyRemoteDescription(offer());const sender=h.transceivers[1].sender as unknown as RTCRtpSender;
 h.controller.setLocalSource(sender,"screen-audio");let accepted: boolean|undefined;const wait=h.controller.waitUntilLocalSourceNegotiated(sender,"screen-audio",()=>true).then(value=>{accepted=value;return value});await tick();expect(accepted).toBeUndefined();const pending=h.send.mock.lastCall![1];
 expect(await h.controller.applyRemoteDescription({...offer(4),type:"answer",reply_to_description_id:id(999)})).toBe("ignored");expect(accepted).toBeUndefined();
 await h.controller.applyRemoteDescription({...offer(5),type:"answer",reply_to_description_id:pending.description_id});expect(await wait).toBe(true);
});
it.each(["recvonly","predicate","replacement"])("rejects source acknowledgement with %s",async reason=>{
 const h=fixture();await h.controller.applyRemoteDescription(offer());const sender=h.transceivers[1].sender as unknown as RTCRtpSender;h.controller.setLocalSource(sender,"screen-audio");let current=true;const wait=h.controller.waitUntilLocalSourceNegotiated(sender,"screen-audio",()=>current);await tick();const pending=h.send.mock.lastCall![1];
 if(reason==="recvonly")h.transceivers[1].currentDirection="recvonly";if(reason==="predicate")current=false;if(reason==="replacement")h.transceivers[1].sender.track=new Track();
 await h.controller.applyRemoteDescription({...offer(3),type:"answer",reply_to_description_id:pending.description_id});expect(await wait).toBe(false);
});
it("expires an unacknowledged source and retires the next waiter on capability revocation",async()=>{
 vi.useFakeTimers();const h=fixture();await h.controller.applyRemoteDescription(offer());const sender=h.transceivers[1].sender as unknown as RTCRtpSender;h.controller.setLocalSource(sender,"screen-audio");const wait=h.controller.waitUntilLocalSourceNegotiated(sender,"screen-audio",()=>true,50);await tick();await vi.advanceTimersByTimeAsync(51);expect(await wait).toBe(false);
 const next=h.controller.waitUntilLocalSourceNegotiated(sender,"screen-audio",()=>true);h.pc.signalingState="stable";await h.controller.applyRemoteDescription({...offer(2),capabilities:[],sources:[{mid:"0",source:"microphone"}]});expect(await next).toBe(false);
});

it("a glare answer is not a source ACK; a fresh local offer must be acknowledged",async()=>{
 const h=fixture();await h.controller.applyRemoteDescription(offer());const sender=h.transceivers[1].sender as unknown as RTCRtpSender;h.controller.setLocalSource(sender,"screen-audio");let result:boolean|undefined;const wait=h.controller.waitUntilLocalSourceNegotiated(sender,"screen-audio",()=>true).then(value=>{result=value;return value});await tick();const first=h.send.mock.lastCall![1].description_id;
 await h.controller.applyRemoteDescription(offer(2));await tick();expect(result).toBeUndefined();const fresh=h.send.mock.lastCall![1];expect(fresh.type).toBe("offer");expect(fresh.description_id).not.toBe(first);
 expect(await h.controller.applyRemoteDescription({...offer(3),type:"answer",reply_to_description_id:first})).toBe("ignored");expect(result).toBeUndefined();await h.controller.applyRemoteDescription({...offer(4),type:"answer",reply_to_description_id:fresh.description_id});expect(await wait).toBe(true);
});

it("retires source waiters on unregister/disposal and never acknowledges a late former owner",async()=>{
 const h=fixture();await h.controller.applyRemoteDescription(offer());const sender=h.transceivers[1].sender as unknown as RTCRtpSender;h.controller.setLocalSource(sender,"screen-audio");const old=h.controller.waitUntilLocalSourceNegotiated(sender,"screen-audio",()=>true);h.controller.setLocalSource(sender,null);expect(await old).toBe(false);
 h.controller.setLocalSource(sender,"screen-audio");const next=h.controller.waitUntilLocalSourceNegotiated(sender,"screen-audio",()=>true);await tick();const pending=h.send.mock.lastCall![1].description_id;h.controller.dispose();expect(await next).toBe(false);expect(await h.controller.applyRemoteDescription({...offer(4),type:"answer",reply_to_description_id:pending})).toBe("ignored");
});

it("keeps a new source waiter pending across an unrelated outstanding offer answer",async()=>{
 const h=fixture();await h.controller.applyRemoteDescription(offer());h.controller.requestNegotiation();await tick();const unrelated=h.send.mock.lastCall![1].description_id;
 const sender=h.transceivers[1].sender as unknown as RTCRtpSender;h.controller.setLocalSource(sender,"screen-audio");let result:boolean|undefined;const wait=h.controller.waitUntilLocalSourceNegotiated(sender,"screen-audio",()=>true).then(value=>{result=value;return value});
 await h.controller.applyRemoteDescription({...offer(3),type:"answer",reply_to_description_id:unrelated});await tick();expect(result).toBeUndefined();const sourceOffer=h.send.mock.lastCall![1];expect(sourceOffer.description_id).not.toBe(unrelated);expect(sourceOffer.sources).toContainEqual({mid:"1",source:"screen-audio"});
 await h.controller.applyRemoteDescription({...offer(4),type:"answer",reply_to_description_id:sourceOffer.description_id});expect(await wait).toBe(true);
});

it("remote screen-audio withdrawal preserves exact microphone and video leases even after a late ended event",async()=>{
 const h=fixture(),video=new Track();video.kind="video";
 h.transceivers.push({mid:"2",sender:{track:new Track()},receiver:{track:video},currentDirection:"sendrecv"});
 const full=sdp()+"m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:2\r\na=sendrecv\r\n";
 await h.controller.applyRemoteDescription({...offer(),sdp:full,sources:[...offer().sources!,{mid:"2",source:"screen-video"}]});
 const initial=h.onMedia.mock.lastCall![0];expect(initial.screenAudio.getTracks()).toEqual([h.tracks[1]]);expect(initial.video.getTracks()).toEqual([video]);
 await h.controller.applyRemoteDescription({...offer(2),sdp:full.replace("a=mid:1\r\na=sendrecv","a=mid:1\r\na=recvonly"),sources:[{mid:"0",source:"microphone"},{mid:"2",source:"screen-video"}]});
 const next=h.onMedia.mock.lastCall![0];expect(next.screenAudio).toBeNull();expect(next.microphone).toBe(initial.microphone);expect(next.video).toBe(initial.video);expect(next.screenAudioSupported).toBe(true);
 h.tracks[1].readyState="ended";h.tracks[1].dispatchEvent(new Event("ended"));expect(h.onMedia.mock.lastCall![0]).toBe(next);
 expect(h.tracks[0].stop).not.toHaveBeenCalled();expect(video.stop).not.toHaveBeenCalled();expect(h.onError).not.toHaveBeenCalled();
});
it("a legacy answer to the initial v1 offer retains microphone and subsequent legacy renegotiation without enabling extra audio",async()=>{
 const h=fixture(true);h.controller.setLocalSource(h.transceivers[0].sender as unknown as RTCRtpSender,"microphone");await tick();expect(h.send.mock.lastCall![1].media_protocol).toBe(1);
 expect(await h.controller.applyRemoteDescription({call_id:"call",type:"answer",sdp:sdp()})).toBe("accepted");const initial=h.onMedia.mock.lastCall![0];expect(initial.microphone.getTracks()).toEqual([h.tracks[0]]);expect(initial.screenAudio).toBeNull();expect(h.controller.canSendScreenAudio()).toBe(false);
 h.controller.requestNegotiation();await tick();expect(h.send.mock.lastCall![1].media_protocol).toBeUndefined();
 const reordered="v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:1\r\na=sendrecv\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendrecv\r\n";
 expect(await h.controller.applyRemoteDescription({call_id:"call",type:"answer",sdp:reordered})).toBe("accepted");expect(h.onMedia.mock.lastCall![0].microphone).toBe(initial.microphone);expect(h.onMedia.mock.lastCall![0].screenAudio).toBeNull();expect(h.controller.canSendScreenAudio()).toBe(false);expect(h.onError).not.toHaveBeenCalled();
});
