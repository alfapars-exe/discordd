import type{LocalParticipant}from "livekit-client";
/** Why capture admission closed. "suspend": the exact Room is alive but re-admitting
 * encryption (SDK reconnect, key rotation); its published tracks are paused in place.
 * "retire": the Room/session can never be re-admitted; owners must stop their capture. */
export type CaptureAdmissionClose="suspend"|"retire";
type Guard={open:boolean;retired:boolean;current:()=>boolean;listeners:Set<(reason:CaptureAdmissionClose)=>void>};
const guards=new WeakMap<LocalParticipant,Guard>();
export function captureAdmissionCurrent(participant:LocalParticipant){const guard=guards.get(participant);try{return !!guard&&guard.open&&guard.current();}catch{return false;}}
/** True only between a suspend and the next open/retire of the participant's live lease. */
export function captureAdmissionSuspended(participant:LocalParticipant){const guard=guards.get(participant);return !!guard&&!guard.open&&!guard.retired;}
export function subscribeCaptureAdmission(participant:LocalParticipant,closed:(reason:CaptureAdmissionClose)=>void){const guard=guards.get(participant);if(!guard)return()=>{};guard.listeners.add(closed);return()=>{guard.listeners.delete(closed);};}
export function invalidateCaptureAdmission(participant:LocalParticipant,reason:CaptureAdmissionClose="retire"){const guard=guards.get(participant);if(!guard)return;guard.open=false;if(reason==="retire")guard.retired=true;else if(guard.retired)reason="retire";for(const closed of [...guard.listeners])closed(reason);}
/** Exact Room lease; closing synchronously retires pending raw capture too. */
export function registerCaptureAdmission(participant:LocalParticipant,current:()=>boolean){
 const previous=guards.get(participant);if(previous){invalidateCaptureAdmission(participant);previous.current=()=>false;}
 const guard:Guard={open:false,retired:false,current,listeners:new Set()};guards.set(participant,guard);
 return{open:()=>{if(guards.get(participant)===guard&&!guard.retired)guard.open=true;},close:(reason:CaptureAdmissionClose="retire")=>{if(guards.get(participant)===guard)invalidateCaptureAdmission(participant,reason);},retire:()=>{if(guards.get(participant)===guard){invalidateCaptureAdmission(participant);/* Keep disposed Room deny-closed. */guard.current=()=>false;}}};
}
