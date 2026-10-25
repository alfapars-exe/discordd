import type{LocalParticipant}from "livekit-client";
type Guard={open:boolean;current:()=>boolean;listeners:Set<()=>void>};
const guards=new WeakMap<LocalParticipant,Guard>();
export function captureAdmissionCurrent(participant:LocalParticipant){const guard=guards.get(participant);try{return !!guard&&guard.open&&guard.current();}catch{return false;}}
export function subscribeCaptureAdmission(participant:LocalParticipant,closed:()=>void){const guard=guards.get(participant);if(!guard)return()=>{};guard.listeners.add(closed);return()=>{guard.listeners.delete(closed);};}
export function invalidateCaptureAdmission(participant:LocalParticipant){const guard=guards.get(participant);if(!guard)return;guard.open=false;for(const closed of [...guard.listeners])closed();}
/** Exact Room lease; closing synchronously retires pending raw capture too. */
export function registerCaptureAdmission(participant:LocalParticipant,current:()=>boolean){
 const previous=guards.get(participant);if(previous){invalidateCaptureAdmission(participant);previous.current=()=>false;}
 const guard:Guard={open:false,current,listeners:new Set()};guards.set(participant,guard);
 return{open:()=>{if(guards.get(participant)===guard)guard.open=true;},close:()=>{if(guards.get(participant)===guard)invalidateCaptureAdmission(participant);},retire:()=>{if(guards.get(participant)===guard){invalidateCaptureAdmission(participant);/* Keep disposed Room deny-closed. */guard.current=()=>false;}}};
}
