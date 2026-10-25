import type { OverlayAuthorizedVideo } from "./overlayMediaBridge";
import type { VideoViewport, VideoViewportLease } from "./videoVisibilityCoordinator";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
export type AuthorizedVideoSource = OverlayAuthorizedVideo & { addViewport:(viewport:VideoViewport)=>VideoViewportLease|null };
export type VideoSourceOwner = "guild"|"p2p"|"group";
export type AuthorizedVideoContext = {owner:VideoSourceOwner;nonce:string;label:string;unavailableReason?:"legacy-video";sources:readonly AuthorizedVideoSource[]};
export type AuthorizedVideoSnapshot = {contexts:readonly AuthorizedVideoContext[];selected:AuthorizedVideoContext|null};
type Binding={context:AuthorizedVideoContext;current:()=>boolean;presented:()=>boolean;auth:ReturnType<typeof getAuthSessionSnapshot>};
const bindings=new Map<string,Binding>(),listeners=new Set<()=>void>();
let snapshot:AuthorizedVideoSnapshot={contexts:[],selected:null},selection:string|null=null;
function current(binding:Binding){try{const auth=getAuthSessionSnapshot();return !!auth.ownerId&&auth.ownerId===binding.auth.ownerId&&auth.generation===binding.auth.generation&&binding.current()}catch{return false}}
function refresh(){const available=[...bindings.values()].filter(current);const contexts=available.map(binding=>({...binding.context,sources:binding.context.sources.filter(source=>{try{return source.current()}catch{return false}})}));
 const presented=available.filter(binding=>{try{return binding.presented()}catch{return false}});
 const selectedNonce=selection&&contexts.some(context=>context.nonce===selection)?selection:presented.length===1?presented[0].context.nonce:contexts.length===1?contexts[0].nonce:null;
 const selected=contexts.find(context=>context.nonce===selectedNonce)??null;
 if(snapshot.selected?.nonce===selected?.nonce&&snapshot.contexts.length===contexts.length&&snapshot.contexts.every((old,index)=>{const next=contexts[index];return old.owner===next.owner&&old.nonce===next.nonce&&old.label===next.label&&old.unavailableReason===next.unavailableReason&&old.sources.length===next.sources.length&&old.sources.every((source,i)=>source===next.sources[i])}))return;
 snapshot={contexts,selected};for(const changed of [...listeners]){try{changed()}catch{ /* Observer failure cannot retain revoked media. */ }}
}
subscribeAuthOwnerChanges(()=>{selection=null;refresh()});subscribeAuthGenerationChanges(()=>{selection=null;refresh()});
/** Empty active calls retain context identity. Multiple calls are never mixed;
 * an ambiguous background selection requires an explicit context choice. */
export function bindAuthorizedVideoSources(owner:VideoSourceOwner,nonce:string,label:string,isCurrent:()=>boolean,presented:()=>boolean=()=>false){const binding:Binding={context:{owner,nonce,label:label.replace(/\p{Cc}/gu," ").trim().slice(0,80)||owner,sources:[]},current:isCurrent,presented,auth:getAuthSessionSnapshot()};bindings.set(nonce,binding);refresh();let active=true;
 return{update(sources:readonly AuthorizedVideoSource[],unavailableReason?:"legacy-video"){if(!active||bindings.get(nonce)!==binding)return;binding.context={...binding.context,sources:[...sources],unavailableReason};refresh()},refresh(){if(active&&bindings.get(nonce)===binding)refresh()},release(){if(!active)return;active=false;if(bindings.get(nonce)===binding){bindings.delete(nonce);if(selection===nonce)selection=null;refresh()}}};
}
export const authorizedVideoSources={getSnapshot:()=>snapshot,subscribe:(changed:()=>void)=>{listeners.add(changed);return()=>{listeners.delete(changed)}},selectContext:(nonce:string|null)=>{selection=nonce;refresh()}};
const publications=new WeakMap<object,AuthorizedVideoSource>();
export function setPublicationVideoSource(publication:object,source:AuthorizedVideoSource){publications.set(publication,source);return()=>{if(publications.get(publication)===source)publications.delete(publication)}}
export const getPublicationVideoSource=(publication:object)=>publications.get(publication);
