import {expect,it} from "vitest";
import {parseP2PMediaSDP,validateP2PDescription} from "./p2pMediaProtocol";
import type {P2PSignalPayload} from "../types/p2p";
const sdp="v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:mic\r\na=sendrecv\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:share\r\na=sendonly\r\nm=video 0 UDP/TLS/RTP/SAVPF 96\r\na=mid:stopped\r\n";
const data=():P2PSignalPayload=>({call_id:"call",type:"offer",sdp,media_protocol:1,description_id:"00000000-0000-4000-8000-000000000001",description_revision:1,capabilities:["screen-audio-v1"],sources:[{mid:"mic",source:"microphone"},{mid:"share",source:"screen-audio"}]});
it("binds sources only to active sending SDP MID and media kinds",()=>{const parsed=validateP2PDescription(data());expect(parsed.map.get("share")).toBe("screen-audio");expect(parsed.sections[2].active).toBe(false)});
it.each(["wrong-kind","unknown-mid","duplicate-source","duplicate-mid","inactive","missing-capability","receive-only","bad-revision","partial","answer-unrelated"])("rejects %s source metadata",reason=>{
 const value=data();switch(reason){case"wrong-kind":value.sources![0].source="camera";break;case"unknown-mid":value.sources![0].mid="absent";break;case"duplicate-source":value.sources![1].source="microphone";break;case"duplicate-mid":value.sources![1].mid="mic";break;case"inactive":value.sources=[{mid:"stopped",source:"camera"}];break;case"missing-capability":value.capabilities=[];break;case"receive-only":value.sdp=sdp.replace("a=sendrecv","a=recvonly");break;case"bad-revision":value.description_revision=Number.MAX_SAFE_INTEGER+1;break;case"partial":delete value.media_protocol;break;case"answer-unrelated":value.type="answer";break}
 expect(()=>validateP2PDescription(value)).toThrow();
});
it("legacy retains section order and rejects duplicate MID",()=>{expect(validateP2PDescription({call_id:"call",type:"offer",sdp}).protocol).toBe(0);expect(parseP2PMediaSDP(sdp).map(section=>section.mid)).toEqual(["mic","share","stopped"]);expect(()=>parseP2PMediaSDP(sdp.replace("a=mid:share","a=mid:mic"))).toThrow()});

it("rejects duplicate session or media directions while allowing a media override",()=>{
 expect(()=>parseP2PMediaSDP("v=0\r\na=sendrecv\r\na=recvonly\r\nm=audio 9 RTP/AVP 111\r\na=mid:0\r\n")).toThrow("Ambiguous session direction");
 expect(()=>parseP2PMediaSDP("v=0\r\nm=audio 9 RTP/AVP 111\r\na=mid:0\r\na=sendrecv\r\na=sendonly\r\n")).toThrow("Ambiguous media direction");
 const sections=parseP2PMediaSDP("v=0\r\na=recvonly\r\nm=audio 9 RTP/AVP 111\r\na=mid:0\r\na=sendonly\r\nm=audio 9 RTP/AVP 111\r\na=mid:1\r\n");expect(sections.map(value=>value.sends)).toEqual([true,false]);
});
