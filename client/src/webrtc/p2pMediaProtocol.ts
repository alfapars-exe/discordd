import type { P2PMediaSource, P2PSignalPayload } from "../types/p2p";
export type MediaSection={mid:string;kind:string;sends:boolean;active:boolean};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sources=new Set<P2PMediaSource>(["microphone","camera","screen-video","screen-audio"]);
/** Only SDP media sections grant a source association. Stream IDs and labels do not. */
export function parseP2PMediaSDP(sdp:string):MediaSection[]{
 if(typeof sdp!=="string"||sdp.length>30000)throw new Error("Invalid media description");
 const result:MediaSection[]=[];let section:MediaSection|null=null,sessionDirection="sendrecv",sessionDirectionSeen=false,mediaDirectionSeen=false;
 for(const raw of sdp.split(/\r?\n/)){const line=raw.trim();
  if(line.startsWith("m=")){mediaDirectionSeen=false;const [kind,port]=line.slice(2).split(/\s+/);if(!/^\d+(?:\/\d+)?$/.test(port??""))throw new Error("Invalid media port");section={mid:"",kind,active:Number.parseInt(port,10)!==0,sends:sessionDirection==="sendrecv"||sessionDirection==="sendonly"};result.push(section)}
  else if(line.startsWith("a=mid:")){if(!section||section.mid)throw new Error("Duplicate media MID");section.mid=line.slice(6)}
  else if(/^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)){const direction=line.slice(2);if(section){if(mediaDirectionSeen)throw new Error("Ambiguous media direction");mediaDirectionSeen=true;section.sends=direction==="sendrecv"||direction==="sendonly"}else{if(sessionDirectionSeen)throw new Error("Ambiguous session direction");sessionDirectionSeen=true;sessionDirection=direction}}
 }
 const seen=new Set<string>();for(const item of result){if(!/^[A-Za-z0-9_-]{1,32}$/.test(item.mid)||seen.has(item.mid))throw new Error("Invalid media MID");seen.add(item.mid)}return result;
}
export function validateP2PDescription(data:P2PSignalPayload){
 if((data.type!=="offer"&&data.type!=="answer")||!data.sdp)throw new Error("Missing SDP");
 const sections=parseP2PMediaSDP(data.sdp);
 if(data.media_protocol===undefined){if(data.description_id!==undefined||data.description_revision!==undefined||data.reply_to_description_id!==undefined||data.capabilities!==undefined||data.sources!==undefined)throw new Error("Partial media protocol");return{protocol:0 as const,sections,map:new Map<string,P2PMediaSource>(),supportsScreenAudio:false}}
 if(data.media_protocol!==1||!uuid.test(data.description_id??"")||data.description_id==="00000000-0000-0000-0000-000000000000"||!Number.isSafeInteger(data.description_revision)||(data.description_revision??0)<=0)throw new Error("Invalid media revision");
 if(data.type==="offer"?data.reply_to_description_id!==undefined:(!uuid.test(data.reply_to_description_id??"")||data.reply_to_description_id==="00000000-0000-0000-0000-000000000000"))throw new Error("Invalid description relation");
 const capabilities=data.capabilities??[];if(!Array.isArray(capabilities)||capabilities.length>1||capabilities.some(value=>value!=="screen-audio-v1"))throw new Error("Unsupported capability");
 const map=new Map<string,P2PMediaSource>(),seen=new Set<P2PMediaSource>();if(!Array.isArray(data.sources??[])||(data.sources?.length??0)>4)throw new Error("Invalid sources");
 for(const item of data.sources??[]){const section=sections.find(value=>value.mid===item.mid);if(!sources.has(item.source)||seen.has(item.source)||map.has(item.mid)||!section?.active||!section.sends||section.kind!==(item.source==="microphone"||item.source==="screen-audio"?"audio":"video")||(item.source==="screen-audio"&&!capabilities.includes("screen-audio-v1")))throw new Error("Source does not match SDP");map.set(item.mid,item.source);seen.add(item.source)}
 return{protocol:1 as const,sections,map,supportsScreenAudio:capabilities.includes("screen-audio-v1")};
}
